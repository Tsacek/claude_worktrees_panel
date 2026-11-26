import { atom, read, update } from 'claude-code'
import type { Color, EngineInterface, Register } from 'claude-code'

import type {
  WtBranchAction,
  WtCheck,
  WtClean,
  WtCleanItem,
  WtFilter,
  WtGroup,
  WtPrefs,
  WtPrIssue,
  WtProgress,
  WtProvider,
  WtRow,
  WtSession,
  WtSizes,
  WtSnapshot,
  WtStatus,
  WtView,
} from '../types'

const PANE = 'worktrees'
const TITLE = 'Worktrees'
const REFRESH_EVERY_MS = 10 * 60 * 1000
const LEASE_MS = 5 * 60 * 1000
// A worktree whose session did something this recently is never offered for removal.
const ACTIVE_MS = 15 * 60 * 1000
const SIZE_TTL_MS = 60 * 60 * 1000
// A branch this far behind the base gets a rebase hint.
const REBASE_HINT = 100

// Change a shape tag when its type changes: values stored by an earlier version are then dropped.
const snapshotAtom = atom({ plugin: 'worktrees-panel', key: 'snapshot' } as const, null, { shape: 'snapshot-1' })
const prefsAtom = atom(
  { plugin: 'worktrees-panel', key: 'prefs' } as const,
  { showArchived: false, autoOpen: true },
  { shape: 'prefs-3' },
)
const selectedAtom = atom({ plugin: 'worktrees-panel', key: 'selected' } as const, [], { shape: 'selected-1' })
const confirmAtom = atom({ plugin: 'worktrees-panel', key: 'confirm' } as const, null, { shape: 'confirm-2' })
const viewAtom = atom(
  { plugin: 'worktrees-panel', key: 'view' } as const,
  { filter: 'all', search: '', expanded: [], collapsed: ['done'] },
  { shape: 'view-1' },
)
const sizesAtom = atom({ plugin: 'worktrees-panel', key: 'sizes' } as const, {}, { shape: 'sizes-1' })
const sizingAtom = atom({ plugin: 'worktrees-panel', key: 'sizing' } as const, false)
const progressAtom = atom({ plugin: 'worktrees-panel', key: 'progress' } as const, null, { shape: 'progress-1' })
const sizeProgressAtom = atom({ plugin: 'worktrees-panel', key: 'sizeProgress' } as const, null, { shape: 'progress-1' })
const cleanAtom = atom({ plugin: 'worktrees-panel', key: 'clean' } as const, null, { shape: 'clean-1' })
// The PR problem kind the person hid; a new kind shows the card again.
const prIssueHiddenAtom = atom({ plugin: 'worktrees-panel', key: 'prIssueHidden' } as const, '')
const busyAtom = atom({ plugin: 'worktrees-panel', key: 'busy' } as const, '')
const errorAtom = atom({ plugin: 'worktrees-panel', key: 'error' } as const, '')
const noticeAtom = atom({ plugin: 'worktrees-panel', key: 'notice' } as const, '')

type Dollar = EngineInterface

const GROUPS: { id: WtGroup; title: string; icon: string; color: Color; hex: string; tip: string }[] = [
  {
    id: 'needs',
    title: 'Needs you',
    icon: '⚑',
    color: 'warning',
    hex: '#EF9F27',
    tip: 'Uncommitted changes, unpushed commits, behind the remote, commits after a merge, or a session waiting',
  },
  { id: 'review', title: 'In review', icon: '⇄', color: 'suggestion', hex: '#378ADD', tip: 'An open or draft PR' },
  { id: 'pushed', title: 'Pushed, no PR', icon: '↑', color: 'inactive', hex: '#888780', tip: 'On the remote without a PR, or detached' },
  {
    id: 'done',
    title: 'Done, can remove',
    icon: '✓',
    color: 'success',
    hex: '#1D9E75',
    tip: 'Merged PR, no commits, or the folder is gone',
  },
  { id: 'main', title: 'Main checkout', icon: '⌂', color: 'subtle', hex: '#B4B2A9', tip: 'The repository folder itself, never removed' },
]

const PR_IMPACT = 'Without PR data the panel cannot show PRs, and merged branches never reach Done.'

type PrHelp = { title: string; impact: string; steps: string[]; token: boolean; signIn: boolean }

// What to tell the person for each way PR status can fail, in the terms of the remote's host.
function prHelp(provider: WtProvider | undefined, kind: WtPrIssue['kind']): PrHelp {
  const host = provider?.name || 'the PR host'
  const off = (title: string, steps: string[], token = false, signIn = false): PrHelp => ({
    title: `PR status is off: ${title}`,
    impact: PR_IMPACT,
    steps,
    token,
    signIn,
  })
  if (kind === 'partial') {
    return { title: 'PR status is incomplete', impact: 'Some branches have no PR data from this scan.', steps: ['Press Retry.'], token: false, signIn: false }
  }
  if (kind === 'unreachable') {
    return off(`${host} cannot be reached`, ['Check the network, and the VPN if your organization uses one.', 'Press Retry.'])
  }
  if (provider?.kind === 'github') {
    if (kind === 'no-gh') {
      return off('the GitHub CLI is not installed', ['Install it: winget install GitHub.cli', 'Sign in from a terminal: gh auth login', 'Press Retry.'])
    }
    if (kind === 'unauthorized') {
      return off('the GitHub CLI is not signed in', ['Sign in from a terminal: gh auth login (or gh auth refresh).', 'Press Retry.'])
    }
  } else if (kind === 'no-token') {
    return off(
      `no ${host} token`,
      [
        `Create a token on the token page: organization ${provider?.org ?? ''}, scope Code > Read.`,
        'Press Store token... and paste it into the window that opens. It is saved in Windows Credential Manager.',
        'Press Retry.',
      ],
      true,
    )
  } else if (kind === 'unauthorized') {
    return off(
      `${host} refused the token`,
      [
        'The token is wrong, expired or revoked: create a new one on the token page (scope Code > Read).',
        'Press Store token... and paste it into the window that opens.',
        'Press Retry.',
      ],
      true,
    )
  } else if (kind === 'forbidden') {
    return off(
      `${host} blocked access`,
      [
        'If your organization requires a VPN, connect it, or disconnect and connect it again.',
        `Sign in to ${host} in your browser (conditional access).`,
        'Press Retry. If it still fails, the token may lack Code > Read: store a new one.',
      ],
      true,
      true,
    )
  }
  return off(`${host} answered with an error`, ['Press Retry. If it keeps failing, the detail below says what it answered.'], false, true)
}

// Translucent fills behind colored text: they read on light and dark themes alike.
const TINTS: Record<string, string> = {
  warning: '#EF9F2733',
  suggestion: '#378ADD33',
  success: '#1D9E7533',
  merged: '#7F77DD33',
  inactive: '#88878033',
  error: '#E24B4A33',
  subtle: '#8887801F',
}

// Set once the pane or its widget has drawn in this module's life: background refresh runs only then.
let paneSeen = false

function iconOf(g: WtGroup): string {
  return GROUPS.find(x => x.id === g)?.icon ?? '●'
}

// Checkbox glyphs for toggles and picks.
function box(on: boolean): string {
  return on ? '☑' : '☐'
}

function storeKey(kind: string, repo: string): string {
  return `${kind}:${repo.toLowerCase()}`
}

function normPath(p: string): string {
  return p.replace(/\//g, '\\').replace(/\\+$/, '').toLowerCase()
}

function asArray<T>(v: T[] | T | null | undefined): T[] {
  if (v === null || v === undefined) return []
  return Array.isArray(v) ? v : [v]
}

function normalize(raw: WtSnapshot): WtSnapshot {
  return {
    ...raw,
    warnings: asArray(raw.warnings),
    worktrees: asArray(raw.worktrees).map(w => ({ ...w, sessions: asArray(w.sessions) })),
  }
}

function plural(n: number, word: string, many = `${word}s`): string {
  return `${n} ${n === 1 ? word : many}`
}

function ago(ms: number, now: number): string {
  if (!ms) return ''
  const s = Math.max(0, Math.round((now - ms) / 1000))
  if (s < 60) return 'just now'
  const m = Math.round(s / 60)
  if (m < 60) return `${m}m`
  const h = Math.round(m / 60)
  if (h < 48) return `${h}h`
  return `${Math.round(h / 24)}d`
}

function agoText(ms: number, now: number): string {
  const a = ago(ms, now)
  return a && a !== 'just now' ? `${a} ago` : a
}

function clip(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text
}

function fmtCount(n: number): string {
  return n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n)
}

function fmtBytes(b: number): string {
  if (b >= 10 * 2 ** 30) return `${Math.round(b / 2 ** 30)} GB`
  if (b >= 2 ** 30) return `${(b / 2 ** 30).toFixed(1)} GB`
  return `${Math.max(1, Math.round(b / 2 ** 20))} MB`
}

function chip(row: WtRow): { label: string; color: Color } {
  const s: WtStatus = row.status
  switch (s) {
    case 'main':
      return { label: 'main', color: 'subtle' }
    case 'merged':
      return { label: `merged #${row.pr?.id ?? ''}`, color: 'success' }
    case 'merged+':
      return { label: `merged #${row.pr?.id ?? ''} +new`, color: 'warning' }
    case 'pr':
      return { label: `${row.pr?.draft ? 'draft' : 'PR'} #${row.pr?.id ?? ''}`, color: 'suggestion' }
    case 'pushed':
      return { label: 'pushed', color: 'inactive' }
    case 'ahead':
      return { label: `${row.unpushed} unpushed`, color: 'warning' }
    case 'local':
      return { label: 'never pushed', color: 'warning' }
    case 'empty':
      return { label: 'no commits', color: 'inactive' }
    case 'detached':
      return { label: 'detached', color: 'subtle' }
    case 'missing':
      return { label: row.leftover ? 'leftover' : 'missing', color: 'error' }
    default:
      return { label: String(s), color: 'subtle' }
  }
}

// One dot color per status, in legend order. Raw colors: the theme has too few distinct keys.
const DOTS = [
  { id: 'pr', label: 'PR', hex: '#378ADD' },
  { id: 'draft', label: 'draft PR', hex: '#7F77DD' },
  { id: 'merged', label: 'merged', hex: '#1D9E75' },
  { id: 'merged+', label: 'commits after merge', hex: '#D4537E' },
  { id: 'pushed', label: 'pushed', hex: '#97C459' },
  { id: 'ahead', label: 'unpushed commits', hex: '#EF9F27' },
  { id: 'local', label: 'never pushed', hex: '#D85A30' },
  { id: 'empty', label: 'no commits', hex: '#B4B2A9' },
  { id: 'detached', label: 'detached', hex: '#5F5E5A' },
  { id: 'missing', label: 'missing or leftover', hex: '#E24B4A' },
  { id: 'main', label: 'main checkout', hex: '#888780' },
] as const

function dotOf(row: WtRow): (typeof DOTS)[number] {
  const id = row.status === 'pr' && row.pr?.draft ? 'draft' : row.status
  return DOTS.find(d => d.id === id) ?? DOTS[DOTS.length - 1]!
}

function waitingSession(row: WtRow): boolean {
  return row.sessions.some(s => s.waiting && !s.archived)
}

function groupOf(row: WtRow): WtGroup {
  if (row.main) return 'main'
  if (row.status === 'missing') return 'done'
  const needs =
    row.dirtyFiles > 0 ||
    row.behindRemote > 0 ||
    row.status === 'ahead' ||
    row.status === 'local' ||
    row.status === 'merged+' ||
    (row.status === 'pr' && row.unpushed > 0) ||
    waitingSession(row)
  if (needs) return 'needs'
  if (row.status === 'pr') return 'review'
  if (row.status === 'merged' || row.status === 'empty') return 'done'
  return 'pushed'
}

function inFilter(g: WtGroup, f: WtFilter): boolean {
  return f === 'all' || f === g
}

function matches(row: WtRow, q: string): boolean {
  if (!q) return true
  const hay = [row.branch, row.name, row.pr ? `#${row.pr.id} ${row.pr.title}` : '', ...row.sessions.map(s => s.title)]
    .join('\n')
    .toLowerCase()
  return q
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean)
    .every(w => hay.includes(w))
}

function factsLine(row: WtRow, now: number): string {
  const parts: string[] = []
  if (row.commits > 0) parts.push(`${plural(row.commits, 'commit')}, +${row.ins} -${row.del} in ${row.files} files`)
  if (row.unpushed > 0 && row.status !== 'merged' && row.status !== 'ahead') parts.push(`${row.unpushed} unpushed`)
  if (row.behindRemote > 0) parts.push(`${row.behindRemote} behind remote`)
  if (row.dirtyFiles > 0) parts.push(`uncommitted: ${row.dirtyFiles} files +${row.dirtyIns} -${row.dirtyDel}`)
  else if (row.status === 'merged' || row.status === 'empty') parts.push('clean')
  if (row.behindBase > 0 && !row.main) parts.push(`${row.behindBase} behind base`)
  if (row.lastCommit) parts.push(`last commit ${agoText(row.lastCommit, now)}`)
  if (row.detail) parts.push(row.detail)
  return parts.join('  ·  ')
}

function activity(row: WtRow): number {
  let t = row.lastCommit || 0
  for (const s of row.sessions) t = Math.max(t, s.lastActivity || 0)
  return t
}

// Why a worktree cannot be picked for removal, or '' when it can. Nothing unpushed is ever offered.
function notRemovable(row: WtRow, cwd: string, now: number): string {
  if (row.main) return 'main checkout'
  if (normPath(row.path) === normPath(cwd)) return 'this session'
  if (row.status === 'missing') return ''
  if (row.sessions.some(s => !s.archived && now - (s.lastActivity || 0) < ACTIVE_MS)) return 'session active'
  if (row.dirtyFiles > 0) return 'uncommitted changes'
  // A merged PR's commits are in the base; its remote branch is usually deleted, so they read as unpushed.
  if (row.status === 'merged') return ''
  if (row.status === 'local' || row.status === 'ahead' || row.unpushed > 0) return 'unpushed commits'
  if (row.status === 'merged+') return 'commits after merge'
  if (row.status === 'detached') return 'detached'
  return ''
}

// The one thing to do next with a worktree, if any: the sentence, and a symbol with a count for the row.
function nextStep(row: WtRow, keep: string): { text: string; short: string; color: Color } | null {
  if (row.main) return null
  if (row.status === 'missing') {
    return { text: row.leftover ? 'leftover files: remove' : 'folder gone: prune', short: '✕', color: 'success' }
  }
  if (row.dirtyFiles > 0) {
    return { text: `commit ${plural(row.dirtyFiles, 'file')}`, short: `✎ ${fmtCount(row.dirtyFiles)}`, color: 'warning' }
  }
  if (row.behindRemote > 0) return { text: `pull ${row.behindRemote}`, short: `↓ ${fmtCount(row.behindRemote)}`, color: 'warning' }
  if (row.status === 'merged+') return { text: 'new commits after merge: new PR', short: '⚠ PR', color: 'warning' }
  if (row.unpushed > 0 && row.status !== 'merged') {
    return { text: `push ${row.unpushed}`, short: `↑ ${fmtCount(row.unpushed)}`, color: 'warning' }
  }
  if (waitingSession(row)) return { text: 'session waiting for you', short: '◷', color: 'warning' }
  if (row.status === 'pushed') return { text: 'open PR', short: '⇄ PR', color: 'suggestion' }
  if (row.status === 'pr' && row.behindBase >= REBASE_HINT) {
    return { text: `rebase: ${row.behindBase} behind`, short: `⟲ ${fmtCount(row.behindBase)}`, color: 'warning' }
  }
  if (row.status === 'merged' || row.status === 'empty') {
    return keep
      ? { text: `keep: ${keep}`, short: '⊘', color: 'inactive' }
      : { text: 'safe to remove', short: '✓', color: 'success' }
  }
  if (row.status === 'detached') return { text: 'detached HEAD', short: '⊗', color: 'subtle' }
  return null
}

function branchAction(row: WtRow): WtBranchAction {
  if (!row.branch || row.main) return 'none'
  if (row.status === 'merged') return 'force' // squash-merged: git cannot see it as merged
  if (row.status === 'empty' || row.status === 'missing') return row.commits === 0 ? 'safe' : 'none'
  return 'none'
}

function sizeOf(sizes: WtSizes, path: string): number {
  return sizes[normPath(path)]?.bytes ?? 0
}

// Opens a folder, file or link the way a double-click does (the Windows shell), and says so when it fails.
async function shellOpen($: Dollar, target: string, kind: 'folder' | 'link'): Promise<void> {
  const quoted = `'${target.replace(/'/g, "''")}'`
  const command = kind === 'folder' ? `Invoke-Item -LiteralPath ${quoted}` : `Start-Process ${quoted}`
  try {
    const res = await $.process.run(['powershell.exe', '-NoProfile', '-NonInteractive', '-Command', command], {
      timeoutMs: 20 * 1000,
    })
    if (res.exitCode !== 0) $.ui.toast(`Could not open ${target}: ${(res.stderr || `exit code ${res.exitCode}`).trim().slice(0, 200)}`)
  } catch (err) {
    $.ui.toast(`Could not open ${target}: ${err instanceof Error ? err.message : String(err)}`)
  }
}

function psArgs(script: string, rest: string[]): string[] {
  return ['powershell.exe', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script, ...rest]
}

type Streamed = { code: number | null; stdout: string; stderr: string; timedOut: boolean }

// Runs a script, passing its "@progress <done> <total> <what>" stderr lines to onStep as they come.
async function runReporting(
  $: Dollar,
  argv: string[],
  opts: { cwd: string; input?: string; timeoutMs: number },
  onStep: (p: WtProgress) => Promise<unknown>,
): Promise<Streamed> {
  const child = $.process.spawn({ argv, cwd: opts.cwd, ...(opts.input === undefined ? {} : { input: opts.input }) })
  let finished = false
  let timedOut = false
  void $.clock.sleep(opts.timeoutMs).then(() => {
    if (finished) return
    timedOut = true
    void child.return({ code: null, signal: null })
  })
  let stdout = ''
  let stderr = ''
  let pending = ''
  let code: number | null = null
  try {
    for (;;) {
      const piece = await child.next()
      if (piece.done) {
        code = piece.value.code
        break
      }
      if (piece.value.stream === 'stdout') {
        stdout += piece.value.text
        continue
      }
      pending += piece.value.text
      for (let i = pending.indexOf('\n'); i >= 0; i = pending.indexOf('\n')) {
        const line = pending.slice(0, i).replace(/\r$/, '')
        pending = pending.slice(i + 1)
        const m = /^@progress (\d+) (\d+) ?(.*)$/.exec(line)
        if (m) await onStep({ value: Number(m[1]), max: Number(m[2]), text: m[3] ?? '' })
        else stderr += `${line}\n`
      }
    }
  } finally {
    finished = true
  }
  return { code, stdout, stderr: stderr + pending, timedOut }
}

function scriptError(r: Streamed, minutes: number): string {
  if (r.timedOut) return `timed out after ${minutes} minutes`
  return (r.stderr || r.stdout || `exit code ${r.code}`).trim().slice(0, 600)
}

async function loadShared($: Dollar): Promise<void> {
  const repo = await $.session.repo()
  if (!repo) return
  const stored = (await $.store.get(storeKey('snapshot', repo.root))) as WtSnapshot | undefined
  if (stored && typeof stored.generatedAt === 'number') {
    const cur = await read($, snapshotAtom)
    if (!cur || cur.generatedAt < stored.generatedAt) await update($, snapshotAtom, () => normalize(stored))
  }
  const sizes = (await $.store.get(storeKey('sizes', repo.root))) as WtSizes | undefined
  if (sizes && typeof sizes === 'object') await update($, sizesAtom, cur => ({ ...cur, ...sizes }))
}

// `remeasure` (the Refresh and Fetch buttons) measures every size again; otherwise only stale ones.
async function refresh($: Dollar, fetch: boolean, remeasure = false): Promise<void> {
  if (await read($, busyAtom)) return
  const repo = await $.session.repo()
  if (!repo) {
    await update($, errorAtom, () => 'This session is not in a git repository.')
    return
  }
  await update($, busyAtom, () => (fetch ? 'Fetching origin and refreshing...' : 'Refreshing...'))
  let ok = false
  try {
    await $.store.set(storeKey('lease', repo.root), Date.now())
    await update($, progressAtom, () => null)
    const argv = psArgs(`${$.plugin.root}/scripts/collect.ps1`, ['-Repo', repo.root, ...(fetch ? ['-Fetch'] : [])])
    const res = await runReporting($, argv, { cwd: await $.session.cwd(), timeoutMs: 5 * 60 * 1000 }, p =>
      update($, progressAtom, () => p),
    )
    const out = res.stdout.trim()
    if (res.code !== 0 || !out.startsWith('{')) {
      await update($, errorAtom, () => scriptError(res, 5))
      return
    }
    const snap = normalize(JSON.parse(out) as WtSnapshot)
    await update($, snapshotAtom, () => snap)
    await update($, errorAtom, () => '')
    await $.store.set(storeKey('snapshot', repo.root), snap)
    // Drop picks of worktrees that are gone or no longer removable.
    const cwd = await $.session.cwd()
    const now = Date.now()
    const removable = new Set(snap.worktrees.filter(r => !notRemovable(r, cwd, now)).map(r => r.path))
    await update($, selectedAtom, sel => sel.filter(p => removable.has(p)))
    ok = true
  } catch (err) {
    const why = err instanceof Error ? err.message : String(err)
    await update($, errorAtom, () => why.slice(0, 600))
  } finally {
    await update($, busyAtom, () => '')
    await update($, progressAtom, () => null)
  }
  if (ok) void measureSizes($, remeasure)
}

// A measurement asked for while one runs: it runs next. `only` null means every worktree.
let queuedMeasure: { force: boolean; only: Set<string> | null } | null = null

// Measures the worktrees whose size is unknown or older than SIZE_TTL_MS (all of them when forced,
// only the given paths when `only` names some).
async function measureSizes($: Dollar, force: boolean, only?: string[]): Promise<void> {
  if (await read($, sizingAtom)) {
    const q = queuedMeasure
    const paths = only ? new Set(only.map(normPath)) : null
    queuedMeasure = {
      force: force || (q?.force ?? false),
      only: !paths || (q && !q.only) ? null : new Set([...(q?.only ?? []), ...paths]),
    }
    return
  }
  const repo = await $.session.repo()
  const snap = await read($, snapshotAtom)
  if (!repo || !snap) return
  const now = Date.now()
  const sizes = await read($, sizesAtom)
  // Missing and leftover folders are measured again after each scan: a partial delete leaves an old size.
  const pick = only ? new Set(only.map(normPath)) : null
  const want = snap.worktrees
    .filter(r => {
      if (r.main) return false
      if (pick) return pick.has(normPath(r.path))
      const s = sizes[normPath(r.path)]
      // A size from before the build split (obj, bin) is measured again.
      if (force || !s || s.obj === undefined || now - s.at > SIZE_TTL_MS) return true
      return r.status === 'missing' && s.at < snap.generatedAt
    })
    .map(r => r.path)
  if (want.length === 0) return
  const leaseKey = storeKey('sizelease', repo.root)
  if (!force && now - Number((await $.store.get(leaseKey)) ?? 0) < LEASE_MS) return
  await $.store.set(leaseKey, now)
  await update($, sizingAtom, () => true)
  await update($, sizeProgressAtom, () => null)
  try {
    const res = await runReporting(
      $,
      psArgs(`${$.plugin.root}/scripts/sizes.ps1`, ['-Repo', repo.root]),
      { cwd: await $.session.cwd(), input: JSON.stringify(want), timeoutMs: 10 * 60 * 1000 },
      p => update($, sizeProgressAtom, () => p),
    )
    const out = res.stdout.trim()
    if (res.code !== 0 || !out.startsWith('[')) return
    type Measured = { path: string; bytes: number; obj?: number; bin?: number }
    const measured = asArray(JSON.parse(out) as Measured[] | Measured)
    const at = Date.now()
    const live = new Set(snap.worktrees.map(r => normPath(r.path)))
    const nextSizes = await update($, sizesAtom, cur => {
      const kept: WtSizes = {}
      for (const [k, v] of Object.entries(cur)) if (live.has(k)) kept[k] = v
      for (const m of measured) {
        kept[normPath(m.path)] = { bytes: Number(m.bytes) || 0, obj: Number(m.obj) || 0, bin: Number(m.bin) || 0, at }
      }
      return kept
    })
    await $.store.set(storeKey('sizes', repo.root), nextSizes)
  } catch {
    // Sizes are a nicety: a failed measurement keeps the old numbers.
  } finally {
    await update($, sizingAtom, () => false)
    await update($, sizeProgressAtom, () => null)
  }
  const next = queuedMeasure
  queuedMeasure = null
  if (next) await measureSizes($, next.force, next.only ? [...next.only] : undefined)
}

type ScriptResult = { path: string; ok: boolean; reason: string; removed: boolean; branchDeleted: boolean; branchError: string }

// Runs remove-worktrees.ps1 over the picked worktrees; with dryRun it only judges them.
async function runRemoval(
  $: Dollar,
  items: { path: string; branch: string; branchAction: WtBranchAction }[],
  opts: { dryRun: boolean; discardSubmodules: boolean },
): Promise<ScriptResult[]> {
  const repo = await $.session.repo()
  if (!repo) throw new Error('This session is not in a git repository.')
  const cwd = await $.session.cwd()
  const rest = ['-Repo', repo.root, '-Protect', cwd]
  if (opts.dryRun) rest.push('-DryRun')
  if (opts.discardSubmodules) rest.push('-DiscardSubmoduleChanges')
  await update($, progressAtom, () => null)
  try {
    const res = await runReporting(
      $,
      psArgs(`${$.plugin.root}/scripts/remove-worktrees.ps1`, rest),
      { cwd: await $.session.cwd(), input: JSON.stringify(items), timeoutMs: 10 * 60 * 1000 },
      p => update($, progressAtom, () => p),
    )
    const out = res.stdout.trim()
    if (res.code !== 0 || !out.startsWith('[')) throw new Error(scriptError(res, 10))
    return asArray(JSON.parse(out) as ScriptResult[] | ScriptResult)
  } finally {
    await update($, progressAtom, () => null)
  }
}

// Opens the remove dialog: judges every picked worktree first, so the dialog shows what will happen.
async function openConfirm($: Dollar, discardSubmodules: boolean): Promise<void> {
  if (await read($, busyAtom)) return
  const snap = await read($, snapshotAtom)
  const picked = await read($, selectedAtom)
  const sizes = await read($, sizesAtom)
  const rows = (snap?.worktrees ?? []).filter(r => picked.includes(r.path))
  if (rows.length === 0) return
  await update($, busyAtom, () => `Checking ${plural(rows.length, 'worktree')} before removal...`)
  $.ui.toast(`Checking ${plural(rows.length, 'worktree')} before removal...`)
  try {
    const items = rows.map(r => ({ path: r.path, branch: r.branch, branchAction: branchAction(r) }))
    const judged = await runRemoval($, items, { dryRun: true, discardSubmodules })
    const prev = await read($, confirmAtom)
    const checks: WtCheck[] = rows.map(r => {
      const j = judged.find(x => normPath(x.path) === normPath(r.path))
      return {
        path: r.path,
        name: r.branch || r.name,
        branch: r.branch,
        branchAction: branchAction(r),
        sessionIds: r.sessions.filter(s => !s.archived).map(s => s.id),
        ok: j?.ok ?? false,
        reason: j?.reason ?? 'not checked',
        bytes: sizeOf(sizes, r.path),
      }
    })
    await update($, confirmAtom, () => ({
      items: checks,
      deleteBranches: prev?.deleteBranches ?? true,
      discardSubmodules,
      archiveSessions: prev?.archiveSessions ?? false,
    }))
    await update($, errorAtom, () => '')
  } catch (err) {
    await update($, errorAtom, () => `Check failed: ${err instanceof Error ? err.message : String(err)}`)
  } finally {
    await update($, busyAtom, () => '')
  }
}

async function confirmRemoval($: Dollar): Promise<void> {
  const c = await read($, confirmAtom)
  if (!c || (await read($, busyAtom))) return
  const go = c.items.filter(i => i.ok)
  if (go.length === 0) return
  await update($, busyAtom, () => `Removing ${plural(go.length, 'worktree')}...`)
  $.ui.toast(`Removing ${plural(go.length, 'worktree')}...`)
  const lines: string[] = []
  try {
    const items = go.map(i => ({ path: i.path, branch: i.branch, branchAction: c.deleteBranches ? i.branchAction : 'none' }))
    const results = await runRemoval($, items, { dryRun: false, discardSubmodules: c.discardSubmodules })
    let removed = 0
    let branches = 0
    let freed = 0
    for (const r of results) {
      const item = go.find(i => normPath(i.path) === normPath(r.path))
      const name = item?.name ?? r.path.split(/[\\/]/).pop() ?? r.path
      if (r.removed) {
        removed++
        freed += item?.bytes ?? 0
      }
      if (r.branchDeleted) branches++
      if (!r.ok) lines.push(`${name}: not removed, ${r.reason}`)
      else if (r.reason) lines.push(`${name}: ${r.reason}`)
      if (r.branchError) lines.push(`${name}: branch kept, ${r.branchError.split('\n')[0]}`)
    }
    let archived = 0
    if (c.archiveSessions) {
      const done = new Set(results.filter(r => r.removed).map(r => normPath(r.path)))
      for (const i of go.filter(x => done.has(normPath(x.path)))) {
        for (const id of i.sessionIds) {
          try {
            await $.tool.call({
              tool: 'mcp__ccd_session_mgmt__archive_session',
              session_id: id,
              reason: 'worktree removed in the Worktrees panel',
            } as never)
            archived++
          } catch (err) {
            lines.push(`session ${id}: not archived, ${err instanceof Error ? err.message : String(err)}`)
          }
        }
      }
    }
    const summary =
      `Removed ${plural(removed, 'worktree')}` +
      (freed ? ` (${fmtBytes(freed)})` : '') +
      (branches ? `, deleted ${plural(branches, 'branch', 'branches')}` : '') +
      (archived ? `, archived ${plural(archived, 'session')}` : '') +
      '.'
    await update($, noticeAtom, () => [summary, ...lines].join('\n'))
    await update($, confirmAtom, () => null)
    await update($, selectedAtom, () => [])
    $.ui.toast(summary)
  } catch (err) {
    await update($, errorAtom, () => `Remove failed: ${err instanceof Error ? err.message : String(err)}`)
  } finally {
    await update($, busyAtom, () => '')
  }
  await refresh($, false)
}

// Shared across sessions through $.store: only refresh when nobody did recently.
async function tick($: Dollar): Promise<void> {
  if (!paneSeen) return
  await loadShared($)
  if (await read($, busyAtom)) return
  const repo = await $.session.repo()
  if (!repo) return
  const snap = await read($, snapshotAtom)
  const lease = Number((await $.store.get(storeKey('lease', repo.root))) ?? 0)
  const now = Date.now()
  if (snap && now - snap.generatedAt < REFRESH_EVERY_MS) {
    await measureSizes($, false)
    return
  }
  if (now - lease < LEASE_MS) return
  await refresh($, false)
}

function buildOf(sizes: WtSizes, path: string): { obj: number; bin: number } {
  const s = sizes[normPath(path)]
  return { obj: s?.obj ?? 0, bin: s?.bin ?? 0 }
}

// Deletes the build output of the worktrees in the clean dialog, then measures them again.
async function runClean($: Dollar): Promise<void> {
  const c = await read($, cleanAtom)
  if (!c || c.items.length === 0 || (await read($, busyAtom))) return
  const repo = await $.session.repo()
  if (!repo) return
  const what = `Cleaning build output in ${plural(c.items.length, 'worktree')}...`
  await update($, busyAtom, () => what)
  $.ui.toast(what)
  await update($, progressAtom, () => null)
  const lines: string[] = []
  let summary = ''
  try {
    const argv = psArgs(`${$.plugin.root}/scripts/clean-build.ps1`, ['-Repo', repo.root, ...(c.includeBin ? ['-IncludeBinaries'] : [])])
    const res = await runReporting(
      $,
      argv,
      { cwd: await $.session.cwd(), input: JSON.stringify(c.items.map(i => ({ path: i.path }))), timeoutMs: 10 * 60 * 1000 },
      p => update($, progressAtom, () => p),
    )
    const out = res.stdout.trim()
    if (res.code !== 0 || !out.startsWith('[')) throw new Error(scriptError(res, 10))
    type Cleaned = {
      path: string
      ok: boolean
      reason: string
      cleaned: string[] | string
      stayed: string[] | string
      build: boolean
      binaries: boolean
    }
    const results = asArray(JSON.parse(out) as Cleaned[] | Cleaned)
    let freed = 0
    let done = 0
    const drops = new Map<string, { obj: boolean; bin: boolean }>()
    for (const r of results) {
      const item = c.items.find(i => normPath(i.path) === normPath(r.path))
      const name = item?.name ?? r.path.split(/[\\/]/).pop() ?? r.path
      const cleaned = asArray(r.cleaned)
      if (cleaned.length > 0) done++
      if (r.build) freed += item?.obj ?? 0
      if (r.binaries) freed += item?.bin ?? 0
      if (r.reason) lines.push(`${name}: ${r.reason}`)
      if (r.build || r.binaries) drops.set(normPath(r.path), { obj: !!r.build, bin: !!r.binaries })
    }
    // The cached sizes drop at once; the measurement below makes them exact.
    if (drops.size > 0) {
      const nextSizes = await update($, sizesAtom, cur => {
        const out: WtSizes = { ...cur }
        for (const [k, d] of drops) {
          const s = out[k]
          if (!s) continue
          const gone = (d.obj ? (s.obj ?? 0) : 0) + (d.bin ? (s.bin ?? 0) : 0)
          out[k] = { ...s, bytes: Math.max(0, s.bytes - gone), obj: d.obj ? 0 : s.obj, bin: d.bin ? 0 : s.bin }
        }
        return out
      })
      await $.store.set(storeKey('sizes', repo.root), nextSizes)
    }
    summary = `Cleaned build output in ${plural(done, 'worktree')}${freed ? `, about ${fmtBytes(freed)} freed` : ''}.`
    $.ui.toast(summary)
  } catch (err) {
    summary = `Clean failed: ${err instanceof Error ? err.message : String(err)}`
  } finally {
    await update($, busyAtom, () => '')
    await update($, progressAtom, () => null)
  }
  await update($, cleanAtom, cur => (cur ? { ...cur, items: [], result: [summary, ...lines].join('\n') } : cur))
  await measureSizes($, true, c.items.map(i => i.path))
}

// Opens the full pane on one filter; the widget's counts call this.
async function openFiltered($: Dollar, filter: WtFilter): Promise<void> {
  paneSeen = true
  await update($, viewAtom, v => ({
    ...v,
    filter,
    search: '',
    collapsed: v.collapsed.filter(g => g !== filter),
  }))
  await $.ui.open({ id: PANE, title: TITLE })
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'worktrees',
      description: 'Show the git worktrees of this repository with their sessions, PR, push status and disk use',
    })
    // A reload mid-action would leave the flags set forever.
    await update($, busyAtom, () => '')
    await update($, sizingAtom, () => false)
    await update($, progressAtom, () => null)
    await update($, sizeProgressAtom, () => null)
    const prefs = (await $.store.get('prefs')) as Partial<WtPrefs> | undefined
    if (prefs && typeof prefs === 'object') {
      await update($, prefsAtom, p => ({
        showArchived: typeof prefs.showArchived === 'boolean' ? prefs.showArchived : p.showArchived,
        autoOpen: typeof prefs.autoOpen === 'boolean' ? prefs.autoOpen : p.autoOpen,
      }))
    }
    await loadShared($)
    $.clock.every(60 * 1000, () => {
      void tick($)
    })
    const started = await next(e)
    if ((await read($, prefsAtom)).autoOpen && (await $.session.repo())) {
      void $.ui.open({ id: PANE, title: TITLE, placement: 'widget' })
    }
    return started
  })

  on('command.run', { command: 'worktrees' }, async $ => {
    paneSeen = true
    await $.ui.open({ id: PANE, title: TITLE })
    await loadShared($)
    const snap = await read($, snapshotAtom)
    if (!snap || Date.now() - snap.generatedAt > 60 * 1000) void refresh($, false)
    else void measureSizes($, false)

    return { text: 'Worktrees pane opened.' }
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    paneSeen = true
    const els = $.ui.resolve(e)
    const { Box, Text, Button, Link, Progress, Input } = els
    const Svg = 'Svg' in els ? els.Svg : undefined
    const terminal = e.surface === 'terminal'
    // Fills and hover need a surface that draws translucent color; the terminal gets plain colored text.
    const tint = (c: Color): Color | undefined => (terminal ? undefined : (TINTS[c as string] ?? TINTS.subtle))
    const snap = await read($, snapshotAtom)
    const busy = await read($, busyAtom)
    const sizes = await read($, sizesAtom)
    const now = Date.now()
    const rows = snap?.worktrees ?? []

    const byGroup = new Map<WtGroup, WtRow[]>(GROUPS.map(g => [g.id, []]))
    for (const r of rows) byGroup.get(groupOf(r))?.push(r)
    for (const list of byGroup.values()) list.sort((a, b) => activity(b) - activity(a))
    const groupBytes = (g: WtGroup) => (byGroup.get(g) ?? []).reduce((t, r) => t + sizeOf(sizes, r.path), 0)
    const count = (g: WtGroup) => byGroup.get(g)?.length ?? 0
    const withBytes = (b: number) => (b ? ` · ${fmtBytes(b)}` : '')

    // The minimized widget: colored counts, each opening the pane on its filter.
    if (e.props.placement === 'widget') {
      // The desktop draws a Button's text plain, so the color sits beside it.
      const pill = (key: string, f: WtFilter, text: string, color: Color) => (
        <Box flexDirection="row" alignItems="center">
          <Text color={color}>{`${iconOf(f as WtGroup)} `}</Text>
          <Button key={key} plain onPress={() => openFiltered($, f)}>
            <Text color={color} weight="semibold">
              {text}
            </Text>
          </Button>
        </Box>
      )
      return (
        <Box flexDirection="row" gap={1} flexWrap="wrap" alignItems="center">
          {count('needs') > 0 ? pill('w-needs', 'needs', `${count('needs')} need you`, 'warning') : null}
          {count('review') > 0 ? pill('w-review', 'review', `${count('review')} in review`, 'suggestion') : null}
          {count('done') > 0 ? pill('w-done', 'done', `${count('done')} can go${withBytes(groupBytes('done'))}`, 'success') : null}
          {snap && count('needs') + count('review') + count('done') === 0 ? <Text color="success">All clear</Text> : null}
          {snap?.prIssue && snap.prIssue.kind !== 'partial' ? (
            <Button key="w-pr" plain onPress={() => openFiltered($, 'all')}>
              <Text color="warning">⚠ no PR data</Text>
            </Button>
          ) : null}
          <Text dimColor>
            {snap ? `${plural(rows.length, 'worktree')} · ${ago(snap.generatedAt, now)}` : 'No scan yet'}
            {busy ? ` · ${busy}` : ''}
          </Text>
          <Button key="w-refresh" plain dimColor label={busy ? '↻ …' : '↻ Refresh'} onPress={() => void refresh($, false, true)} />
        </Box>
      )
    }

    const sizing = await read($, sizingAtom)
    const progress = await read($, progressAtom)
    const sizeProgress = await read($, sizeProgressAtom)
    const progressBar = (
      <Progress
        label={busy}
        value={progress ? progress.value : undefined}
        max={progress ? Math.max(1, progress.max) : undefined}
        valueText={progress ? `${progress.value} of ${progress.max}${progress.text ? ` · ${progress.text}` : ''}` : undefined}
      />
    )
    const view = await read($, viewAtom)
    const error = await read($, errorAtom)
    const notice = await read($, noticeAtom)
    const prefs = await read($, prefsAtom)
    const selected = await read($, selectedAtom)
    const confirm = await read($, confirmAtom)
    const cwd = await $.session.cwd()
    const totalBytes = rows.reduce((t, r) => t + (r.main ? 0 : sizeOf(sizes, r.path)), 0)
    const bytesOf = (paths: string[]) => paths.reduce((t, p) => t + sizeOf(sizes, p), 0)
    const prIssueHidden = await read($, prIssueHiddenAtom)
    const prIssue = snap?.prIssue ?? null
    const provider = snap?.provider
    const help = prIssue && prIssue.kind !== prIssueHidden ? prHelp(provider, prIssue.kind) : null
    const prCard =
      prIssue && help ? (
        <Box flexDirection="column" gap={1} borderStyle="round" borderColor="warning" paddingX={1} backgroundColor={tint('warning')}>
          <Box flexDirection="column">
            <Text weight="semibold" color="warning">{`⚠ ${help.title}`}</Text>
            <Text dimColor>{help.impact}</Text>
          </Box>
          <Box flexDirection="column">
            {help.steps.map((step, i) => (
              <Text key={`pr-step:${i}`}>{`${i + 1}. ${step}`}</Text>
            ))}
          </Box>
          {prIssue.detail ? <Text dimColor>{prIssue.detail}</Text> : null}
          <Box flexDirection="row" gap={1} flexWrap="wrap" alignItems="center">
            {help.token && provider?.tokenPage ? <Link href={provider.tokenPage} label="Open token page" /> : null}
            {help.signIn && provider?.home ? <Link href={provider.home} label={`Open ${provider.name}`} /> : null}
            {help.token && provider?.kind === 'ado' ? (
              <Button
                key="pr-store"
                label="✎ Store token..."
                onPress={async () => {
                  // Its own console window: the token is typed there and never passes through the panel.
                  const script = `${$.plugin.root}/scripts/set-pat.ps1`.replace(/\//g, '\\')
                  const arg = (v: string) => `'"${v.replace(/'/g, "''")}"'`
                  const args = ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script]
                    .concat(['-Target', provider.tokenName, '-AdoApi', provider.api, '-TokenPage', provider.tokenPage, '-Org', provider.org])
                    .map(arg)
                  await $.process.run(['powershell.exe', '-NoProfile', '-Command', `Start-Process powershell.exe -ArgumentList ${args.join(',')}`])
                  $.ui.toast('A window asks for the token. Press Retry here once it is stored.')
                }}
              />
            ) : null}
            <Button key="pr-retry" label="↻ Retry" onPress={() => void refresh($, false)} />
            <Button key="pr-hide" plain dimColor label="Hide" onPress={() => update($, prIssueHiddenAtom, () => prIssue.kind)} />
          </Box>
        </Box>
      ) : null

    const removableDone = (byGroup.get('done') ?? []).filter(r => !notRemovable(r, cwd, now))

    const setPrefs = async (change: (p: WtPrefs) => WtPrefs) => {
      const nextPrefs = await update($, prefsAtom, change)
      await $.store.set('prefs', nextPrefs)
    }
    const setView = (change: (v: WtView) => WtView) => update($, viewAtom, change)
    const setFilter = (f: WtFilter) =>
      setView(v => ({ ...v, filter: f, collapsed: f === 'all' ? v.collapsed : v.collapsed.filter(g => g !== f) }))
    const openSession = (id: string) => shellOpen($, `claude://claude.ai/epitaxy/${id}`, 'link')
    const openFolder = (path: string) => shellOpen($, path, 'folder')
    // A tooltip: shown above the control while the pointer is on it. Dark on light text reads on any theme.
    const withTip = (
      key: string,
      tip: string,
      control: ReturnType<typeof Button> | ReturnType<typeof Text>,
      side: 'left' | 'right' = 'right',
    ) =>
      // The terminal has no pointer hover: the control alone.
      terminal ? (
        control
      ) : (
      <Box key={`tip:${key}`} position="relative" flexShrink={0}>
        {control}
        <Box
          position="absolute"
          top={-1}
          {...(side === 'left' ? { left: 0 } : { right: 0 })}
          display="none"
          hover={{ display: 'flex' }}
        >
          <Text color="#F1EFE8" backgroundColor="#2C2C2A" size="footnote" wrap="truncate-end">
            {` ${tip} `}
          </Text>
        </Box>
      </Box>
    )
    const copy = async (text: string, surface: typeof e.surface) => {
      await $.ui.copy({ text, surface })
      $.ui.toast(`Copied ${text}`)
    }

    // While a scan runs the old list stays, dimmed, under a progress bar.
    const cleaning = busy.startsWith('Cleaning')
    const fetching = busy.startsWith('Fetching')
    const scanning = fetching || busy.startsWith('Refreshing')

    // The search filters as you type; the field keeps its own width, so the scan buttons share its row.
    const toolbar = (
      <Box flexDirection="row" gap={1} alignItems="center" flexWrap="wrap">
        <Input
          key="search"
          placeholder="Search branch, PR, session title"
          value={view.search}
          submitLabel="↵"
          onInput={text => void setView(v => ({ ...v, search: text }))}
          onSubmit={text => void setView(v => ({ ...v, search: text }))}
        />
        <Button
          key="refresh"
          label={scanning && !fetching ? '↻ Refreshing…' : '↻ Refresh'}
          onPress={() => void refresh($, false, true)}
        />
        <Button key="fetch" label={fetching ? '⇣ Fetching…' : '⇣ Fetch'} onPress={() => void refresh($, true, true)} />
      </Box>
    )

    // One summary tile per filter. Only a Button takes a click, so the tile is one Button holding the
    // number and the label; its fill carries the color, since the desktop draws a Button's text plain.
    const tile = (f: WtFilter, value: string, label: string, color: Color) => {
      const icon = f === 'all' ? '▦' : iconOf(f)
      const active = view.filter === f
      return (
        <Box
          key={`tile:${f}`}
          flexGrow={1}
          flexShrink={1}
          borderStyle="round"
          borderColor={active ? color : undefined}
          borderDimColor={!active}
          backgroundColor={tint(color)}
        >
          <Button key={`filter:${f}`} plain label={`${icon} ${value} ${label}`} onPress={() => setFilter(f)}>
            <Text color={color}>{`${icon} `}</Text>
            <Text size="heading" weight="semibold" color={color} tabular>
              {value}
            </Text>
            <Text dimColor={!active}>{`  ${label}`}</Text>
          </Button>
        </Box>
      )
    }
    // The All tile spans the row above the three group filters.
    const tiles = (
      <Box flexDirection="column" gap={1}>
        <Box flexDirection="row">{tile('all', String(rows.length), `All worktrees${withBytes(totalBytes)}`, 'text')}</Box>
        <Box flexDirection="row" gap={1} flexWrap="wrap">
          {tile('needs', String(count('needs')), 'Need you', 'warning')}
          {tile('review', String(count('review')), 'In review', 'suggestion')}
          {tile('done', String(count('done')), `Can go${withBytes(groupBytes('done'))}`, 'success')}
        </Box>
      </Box>
    )

    // Disk by group: a bar where the surface draws SVG, and a legend that also stands alone on the terminal.
    const barGroups = GROUPS.filter(g => g.id !== 'main')
      .map(g => ({ ...g, bytes: groupBytes(g.id) }))
      .filter(g => g.bytes > 0)
    let bar: string | null = null
    if (Svg && totalBytes > 0) {
      let x = 0
      const gap = 6
      const room = 1000 - gap * (barGroups.length - 1)
      const rects = barGroups.map(g => {
        const w = Math.max(2, (g.bytes / totalBytes) * room)
        const r = `<rect x="${x.toFixed(1)}" y="0" width="${w.toFixed(1)}" height="8" rx="3" fill="${g.hex}"/>`
        x += w + gap
        return r
      })
      bar = `<svg xmlns="http://www.w3.org/2000/svg" width="1000" height="8" viewBox="0 0 1000 8" preserveAspectRatio="none">${rects.join('')}</svg>`
    }
    const diskView = snap ? (
      <Box flexDirection="column">
        {bar && Svg ? (
          <Svg
            source={bar}
            height={8}
            alt={barGroups.map(g => `${g.title} ${fmtBytes(g.bytes)}`).join(', ')}
          />
        ) : null}
        <Box flexDirection="row" gap={2} flexWrap="wrap">
          {barGroups.map(g => (
            <Text key={`leg:${g.id}`}>
              <Text color={g.color}>■ </Text>
              <Text dimColor>{`${g.title.toLowerCase()} ${fmtBytes(g.bytes)}`}</Text>
            </Text>
          ))}
          <Text dimColor>
            {`updated ${agoText(snap.generatedAt, now)}`}
            {sizing ? ` · measuring sizes${sizeProgress ? ` ${sizeProgress.value} of ${sizeProgress.max}` : '...'}` : ''}
            {snap.prEnabled ? '' : ' · no PR data'}
          </Text>
        </Box>
      </Box>
    ) : (
      <Text dimColor>No data yet.</Text>
    )

    const selectionBar =
      selected.length > 0 ? (
        <Box flexDirection="row" gap={1} flexWrap="wrap">
          <Button
            key="remove"
            variant="primary"
            label={`✕ Remove ${selected.length} selected${withBytes(bytesOf(selected))}...`}
            onPress={() => void openConfirm($, false)}
          />
          <Button key="pick-none" label="☐ Clear selection" onPress={() => update($, selectedAtom, () => [])} />
        </Box>
      ) : null

    const clean = await read($, cleanAtom)
    const cleanItemOf = (row: WtRow): WtCleanItem => {
      const b = buildOf(sizes, row.path)
      const keep = notRemovable(row, cwd, now)
      return {
        path: row.path,
        name: row.branch || row.name,
        obj: b.obj,
        bin: b.bin,
        risk: keep === 'session active' || keep === 'this session' ? keep : '',
      }
    }
    const openClean = (origin: string, list: WtRow[]) =>
      update($, cleanAtom, prev => ({
        origin,
        items: list.map(cleanItemOf),
        includeBin: prev?.includeBin ?? false,
        result: '',
      }))
    // The dialog, its progress or its result, drawn where it was opened from.
    const cleanView = (origin: string) => {
      if (!clean || clean.origin !== origin) return null
      if (cleaning) return progressBar
      if (clean.result) {
        return (
          <Box flexDirection="column">
            <Text>{clean.result}</Text>
            <Button key="clean-ok" plain dimColor label="✕ dismiss" onPress={() => update($, cleanAtom, () => null)} />
          </Box>
        )
      }
      if (clean.items.length === 0) return null
      const patterns = snap?.build ?? { dirs: [], binaries: [] }
      const objSum = clean.items.reduce((t, i) => t + i.obj, 0)
      const binSum = clean.items.reduce((t, i) => t + i.bin, 0)
      const risky = clean.items.filter(i => i.risk)
      return (
        <Box flexDirection="column" gap={1} borderStyle="round" borderColor="suggestion" paddingX={1}>
          <Text weight="semibold">
            {`Clean build output in ${plural(clean.items.length, 'worktree')} · frees about ${fmtBytes(
              objSum + (clean.includeBin ? binSum : 0),
            )}?`}
          </Text>
          <Box flexDirection="column">
            {clean.items.map(i => (
              <Text key={`clean-item:${i.path}`}>
                <Text color="suggestion">⌫ </Text>
                {i.name}
                <Text dimColor>
                  {`  build ${fmtBytes(i.obj)}${clean.includeBin && i.bin ? `  + binaries ${fmtBytes(i.bin)}` : ''}`}
                </Text>
                {i.risk ? <Text color="warning">{`  - ${i.risk}`}</Text> : ''}
              </Text>
            ))}
          </Box>
          <Text dimColor>
            {`Deletes the build output (${patterns.dirs.join(', ')}), only folders git ignores. Sources stay; the next build makes it again.`}
          </Text>
          {risky.length > 0 ? (
            <Text color="warning">A session is active in a worktree marked above: a build running there would break.</Text>
          ) : null}
          {patterns.binaries.length > 0 ? (
            <Button
              key="clean-bin"
              plain
              label={`${box(clean.includeBin)} Also delete binaries (${patterns.binaries.join(', ')}, ${fmtBytes(binSum)}): running them needs a build first`}
              onPress={() => update($, cleanAtom, c => (c ? { ...c, includeBin: !c.includeBin } : c))}
            />
          ) : null}
          <Box flexDirection="row" gap={1}>
            <Button key="clean-go" variant="primary" label={`⌫ Clean ${clean.items.length}`} onPress={() => void runClean($)} />
            <Button key="clean-cancel" label="↩ Cancel" onPress={() => update($, cleanAtom, () => null)} />
          </Box>
        </Box>
      )
    }
    // Idle worktrees: no session active in the last minutes, not this session's, not the main checkout.
    const cleanable = rows.filter(r => !r.main && r.status !== 'missing' && buildOf(sizes, r.path).obj > 0)
    const idleCleanable = cleanable.filter(r => !cleanItemOf(r).risk)
    const buildTotal = cleanable.reduce((t, r) => t + buildOf(sizes, r.path).obj + buildOf(sizes, r.path).bin, 0)
    const idleObj = idleCleanable.reduce((t, r) => t + buildOf(sizes, r.path).obj, 0)
    const buildLine =
      buildTotal > 0 ? (
        <Box flexDirection="column" gap={1}>
          <Box flexDirection="row" gap={1} alignItems="center" flexWrap="wrap">
            <Text dimColor>{`⌫ build output ${fmtBytes(buildTotal)} in ${plural(cleanable.length, 'worktree')}`}</Text>
            {idleCleanable.length > 0 && !(clean && clean.origin === 'all') ? (
              <Button
                key="clean-idle"
                label={`⌫ Clean ${plural(idleCleanable.length, 'idle worktree')} · ${fmtBytes(idleObj)}...`}
                onPress={() => openClean('all', idleCleanable)}
              />
            ) : null}
          </Box>
          {cleanView('all')}
        </Box>
      ) : (
        cleanView('all')
      )

    const confirmView = confirm ? (
      <Box flexDirection="column" gap={1} borderStyle="round" borderColor="warning" paddingX={1}>
        <Text weight="semibold">
          {`Remove ${plural(confirm.items.filter(i => i.ok).length, 'worktree')}`}
          {withBytes(confirm.items.filter(i => i.ok).reduce((t, i) => t + i.bytes, 0))}?
        </Text>
        <Box flexDirection="column">
          {confirm.items.map(i => (
            <Text color={i.ok ? undefined : 'inactive'}>
              <Text color={i.ok ? 'success' : 'inactive'}>{i.ok ? '● remove  ' : '○ skip    '}</Text>
              {i.name}
              {i.bytes ? `  (${fmtBytes(i.bytes)})` : ''}
              {i.ok ? (confirm.deleteBranches && i.branchAction !== 'none' ? '  + delete branch' : '') : `  - ${i.reason}`}
              {i.ok && i.reason ? <Text color="warning">{`  - ${i.reason}`}</Text> : ''}
            </Text>
          ))}
        </Box>
        <Text dimColor>
          Each folder is deleted with its build output. Links to shared data are unlinked first. Nothing
          uncommitted or unpushed can be lost: such worktrees are skipped.
        </Text>
        <Box flexDirection="column">
          <Button
            key="opt-branches"
            plain
            label={`${box(confirm.deleteBranches)} Delete local branches (merged / empty only)`}
            onPress={() => update($, confirmAtom, c => (c ? { ...c, deleteBranches: !c.deleteBranches } : c))}
          />
          <Button
            key="opt-sub"
            plain
            label={`${box(confirm.discardSubmodules)} Discard edits inside submodules`}
            onPress={async () => {
              const c = await read($, confirmAtom)
              await openConfirm($, !(c?.discardSubmodules ?? false))
            }}
          />
          <Button
            key="opt-archive"
            plain
            label={`${box(confirm.archiveSessions)} Archive their sessions (and idle ones they started)`}
            onPress={() => update($, confirmAtom, c => (c ? { ...c, archiveSessions: !c.archiveSessions } : c))}
          />
        </Box>
        <Box flexDirection="row" gap={1}>
          {confirm.items.some(i => i.ok) ? (
            <Button
              key="do-remove"
              variant="primary"
              label={`✕ Remove ${confirm.items.filter(i => i.ok).length}`}
              onPress={() => void confirmRemoval($)}
            />
          ) : null}
          <Button key="cancel-remove" label="↩ Cancel" onPress={() => update($, confirmAtom, () => null)} />
        </Box>
      </Box>
    ) : null

    const sessionButton = (s: WtSession) => {
      const waiting = s.waiting && !s.archived
      return (
        <Box flexDirection="row" alignItems="center">
          <Text color={waiting ? 'warning' : 'inactive'}>● </Text>
          <Button key={`sess:${s.id}`} onPress={() => openSession(s.id)}>
            <Text dimColor={s.archived}>{s.title || '(untitled)'}</Text>
            <Text dimColor>{` · ${waiting ? 'waiting' : ago(s.lastActivity, now)}${s.archived ? ' · archived' : ''}`}</Text>
          </Button>
        </Box>
      )
    }

    const details = (row: WtRow, keep: string) => {
      const shown = row.sessions.filter(s => prefs.showArchived || !s.archived)
      const hidden = row.sessions.length - shown.length
      const facts = factsLine(row, now)
      return (
        <Box flexDirection="column" marginLeft={2} paddingX={1} backgroundColor={tint('subtle')} gap={1}>
          <Box flexDirection="column">
            {facts ? <Text dimColor>{facts}</Text> : null}
            {row.pr ? <Link href={row.pr.url} label={`PR ${row.pr.id} · ${row.pr.title} (${row.pr.status})`} /> : null}
            {keep && keep !== 'main checkout' ? <Text dimColor>{`kept from cleanup: ${keep}`}</Text> : null}
            <Text dimColor mono>
              {row.path}
            </Text>
          </Box>
          {shown.length > 0 || hidden > 0 ? (
            <Box flexDirection="row" gap={1} flexWrap="wrap" alignItems="center">
              {shown.map(sessionButton)}
              {hidden > 0 ? (
                <Button
                  key={`arch:${row.path}`}
                  plain
                  dimColor
                  label={`+${hidden} archived`}
                  onPress={() => setPrefs(p => ({ ...p, showArchived: true }))}
                />
              ) : null}
            </Box>
          ) : null}
          <Box flexDirection="row" gap={1} flexWrap="wrap">
            <Button key={`copy:${row.path}`} label="⧉ Copy path" onPress={pe => copy(row.path, pe.surface)} />
            {row.branch ? (
              <Button key={`copyb:${row.path}`} label="⧉ Copy branch" onPress={pe => copy(row.branch, pe.surface)} />
            ) : null}
            {row.status !== 'missing' ? (
              <Button key={`open:${row.path}`} label="▤ Explorer" onPress={() => openFolder(row.path)} />
            ) : null}
            {row.status !== 'missing' ? (
              <Button
                key={`code:${row.path}`}
                label="‹› VS Code"
                onPress={() => void $.process.run(['cmd.exe', '/c', 'code', row.path])}
              />
            ) : null}
            {row.status !== 'missing' && !row.main && buildOf(sizes, row.path).obj + buildOf(sizes, row.path).bin > 0 ? (
              <Button
                key={`clean:${row.path}`}
                label={`⌫ Clean build output · ${fmtBytes(buildOf(sizes, row.path).obj)}...`}
                onPress={() => openClean(row.path, [row])}
              />
            ) : null}
          </Box>
          {cleanView(row.path)}
        </Box>
      )
    }

    const rowView = (row: WtRow, g: (typeof GROUPS)[number]) => {
      const c = chip(row)
      const keep = notRemovable(row, cwd, now)
      const isPicked = selected.includes(row.path)
      const isOpen = view.expanded.includes(row.path)
      const step = nextStep(row, keep)
      const bytes = row.main ? 0 : sizeOf(sizes, row.path)
      const latest = row.sessions.filter(s => !s.archived).sort((a, b) => b.lastActivity - a.lastActivity)[0]
      const toggle = () =>
        setView(v => ({
          ...v,
          expanded: v.expanded.includes(row.path) ? v.expanded.filter(p => p !== row.path) : [...v.expanded, row.path],
        }))
      return (
        <Box key={`wt:${row.path}`} flexDirection="column">
          <Box
            key={`line:${row.path}`}
            flexDirection="row"
            gap={1}
            alignItems="center"
            backgroundColor={terminal ? undefined : `${g.hex}${isOpen ? '33' : '14'}`}
            hover={terminal ? undefined : { backgroundColor: `${g.hex}33` }}
          >
            {terminal ? <Text color={scanning ? 'inactive' : g.color}>▍</Text> : null}
            {keep ? null : (
              <Button
                key={`pick:${row.path}`}
                plain
                onPress={() =>
                  update($, selectedAtom, sel => (sel.includes(row.path) ? sel.filter(p => p !== row.path) : [...sel, row.path]))
                }
              >
                <Text color={isPicked ? 'success' : 'inactive'}>{box(isPicked)}</Text>
              </Button>
            )}
            <Button key={`chev:${row.path}`} plain dimColor label={isOpen ? '▾' : '▸'} onPress={toggle} />
            {terminal ? (
              <Box flexShrink={0}>
                <Text color={scanning ? 'inactive' : c.color} weight="semibold">
                  {c.label}
                </Text>
              </Box>
            ) : (
              withTip(
                `st:${row.path}`,
                `${c.label}${row.detail ? ` · ${clip(row.detail, 60)}` : ''}`,
                <Text color={scanning ? '#B4B2A9' : dotOf(row).hex}>●</Text>,
                'left',
              )
            )}
            {/* The branch area takes what the fixed columns leave (width 0, then grows), so nothing to its
                right moves; on hover the buttons show at its end and only the branch name is cut. */}
            {/* No overflow clip here: it would cut the buttons' tooltips, drawn above the row. */}
            <Box flexGrow={1} flexShrink={1} width={0} minWidth={16} flexDirection="row" alignItems="center">
              <Box flexShrink={1} minWidth={0} overflow="hidden">
                <Button key={`row:${row.path}`} plain onPress={toggle}>
                  <Text mono dimColor={scanning}>
                    {row.branch || row.name}
                  </Text>
                </Button>
              </Box>
              {terminal ? null : (
                <Box display="none" hover={{ display: 'flex' }} flexShrink={0} flexDirection="row" gap={1} marginLeft={1}>
                  {latest
                    ? withTip(
                        `hs:${row.path}`,
                        `Open session: ${clip(latest.title || '(untitled)', 40)}`,
                        <Button key={`hs:${row.path}`} label="↗" onPress={() => openSession(latest.id)} />,
                        'left',
                      )
                    : null}
                  {row.status !== 'missing'
                    ? withTip(
                        `he:${row.path}`,
                        'Open in Explorer',
                        <Button key={`he:${row.path}`} label="▤" onPress={() => openFolder(row.path)} />,
                        'left',
                      )
                    : null}
                  {withTip(
                    `hc:${row.path}`,
                    'Copy path',
                    <Button key={`hc:${row.path}`} label="⧉" onPress={pe => copy(row.path, pe.surface)} />,
                  )}
                </Box>
              )}
            </Box>
            {/* Fixed-width, right-aligned columns: the numbers line up from row to row. */}
            <Box flexShrink={0} flexDirection="row" gap={1}>
              <Box width={13} flexShrink={0} justifyContent="flex-end">
                {row.commits > 0 ? (
                  <Text tabular wrap="truncate-end">
                    <Text color={scanning ? 'inactive' : 'success'}>{`+${fmtCount(row.ins)}`}</Text>
                    <Text color={scanning ? 'inactive' : 'error'}>{` -${fmtCount(row.del)}`}</Text>
                  </Text>
                ) : null}
              </Box>
              <Box width={4} flexShrink={0} justifyContent="flex-end">
                <Text dimColor tabular wrap="truncate-end">
                  {ago(activity(row), now)}
                </Text>
              </Box>
              <Box width={7} flexShrink={0} justifyContent="flex-end">
                {bytes ? (
                  <Text dimColor tabular wrap="truncate-end">
                    {fmtBytes(bytes)}
                  </Text>
                ) : null}
              </Box>
              {removing && isPicked ? (
                <Text color="warning" wrap="truncate-end">
                  {busy.startsWith('Removing') ? '⧗ removing…' : '⧗ checking…'}
                </Text>
              ) : terminal ? (
                step ? (
                  <Text color={scanning ? 'inactive' : step.color} wrap="truncate-end">
                    {step.text}
                  </Text>
                ) : null
              ) : (
                <Box width={7} flexShrink={0} justifyContent="flex-end">
                  {step
                    ? withTip(
                        `hint:${row.path}`,
                        step.text,
                        <Text color={scanning ? 'inactive' : step.color} tabular>
                          {step.short}
                        </Text>,
                      )
                    : null}
                </Box>
              )}
            </Box>
          </Box>
          {isOpen ? details(row, keep) : null}
        </Box>
      )
    }

    const query = view.search.trim()
    // Removal feedback sits where the Remove button is: under the Done header when that group is drawn.
    const removing = !!busy && !scanning && !cleaning
    const removalError = /^(Check|Remove) failed/.test(error) ? error : ''
    const removalPanel =
      removing || removalError || notice || confirmView || selectionBar ? (
        <Box flexDirection="column" gap={1}>
          {removing ? progressBar : null}
          {removalError ? <Text color="error">{removalError}</Text> : null}
          {notice ? (
            <Box flexDirection="column">
              <Text>{notice}</Text>
              <Button key="notice-ok" plain dimColor label="✕ dismiss" onPress={() => update($, noticeAtom, () => '')} />
            </Box>
          ) : null}
          {confirmView ?? selectionBar}
        </Box>
      ) : null
    let panelInGroup = false

    const groupViews = GROUPS.filter(g => inFilter(g.id, view.filter)).map(g => {
      const list = (byGroup.get(g.id) ?? []).filter(r => matches(r, query))
      if (list.length === 0) return null
      const folded = !query && view.filter === 'all' && view.collapsed.includes(g.id)
      const sizeText = g.id === 'main' ? '' : withBytes(bytesOf(list.map(r => r.path)))
      return (
        <Box key={`grp:${g.id}`} flexDirection="column">
          <Box flexDirection="row" gap={1} alignItems="center">
            {withTip(`grp:${g.id}`, `${g.title}: ${g.tip}`, <Text color={scanning ? 'inactive' : g.color}>{g.icon}</Text>, 'left')}
            <Button
              key={`fold:${g.id}`}
              plain
              onPress={() =>
                setView(v => ({
                  ...v,
                  collapsed: v.collapsed.includes(g.id) ? v.collapsed.filter(x => x !== g.id) : [...v.collapsed, g.id],
                }))
              }
            >
              <Text dimColor>{folded ? '▸ ' : '▾ '}</Text>
              <Text weight="semibold">{g.title}</Text>
            </Button>
            <Box flexGrow={1}>
              <Text dimColor>{`${list.length}${sizeText}${folded ? '  · folded' : ''}`}</Text>
            </Box>
            {g.id === 'done' && removableDone.length > 0 && !confirm ? (
              <Button
                key="rm-done"
                label={
                  removing
                    ? `⧗ ${busy.startsWith('Removing') ? 'Removing' : 'Checking'}…`
                    : `✕ Remove ${removableDone.length === list.length ? 'all ' : ''}${removableDone.length}${withBytes(
                        bytesOf(removableDone.map(r => r.path)),
                      )}...`
                }
                onPress={async () => {
                  await update($, selectedAtom, () => removableDone.map(r => r.path))
                  await openConfirm($, false)
                }}
              />
            ) : null}
          </Box>
          {g.id === 'done' && removalPanel ? ((panelInGroup = true), removalPanel) : null}
          {folded ? null : <Box flexDirection="column">{list.map(r => rowView(r, g))}</Box>}
        </Box>
      )
    })
    const anyShown = groupViews.some(Boolean)

    const options = (
      <Box flexDirection="row" gap={1} flexWrap="wrap">
        <Button
          key="opt-archived"
          plain
          dimColor
          label={`${box(prefs.showArchived)} archived sessions`}
          onPress={() => setPrefs(p => ({ ...p, showArchived: !p.showArchived }))}
        />
        <Button
          key="opt-autoopen"
          plain
          dimColor
          label={`${box(prefs.autoOpen)} widget in every session`}
          onPress={() => setPrefs(p => ({ ...p, autoOpen: !p.autoOpen }))}
        />
        {snap ? <Text dimColor>{`base ${snap.base} · ${snap.repo}`}</Text> : null}
      </Box>
    )

    return (
      <Box flexDirection="column" gap={1}>
        {toolbar}
        {scanning ? (
          <Box flexDirection="column">
            {progressBar}
            {snap ? <Text dimColor>{`Showing the scan from ${agoText(snap.generatedAt, now)} until it finishes.`}</Text> : null}
          </Box>
        ) : null}
        {prCard}
        {tiles}
        {diskView}
        {buildLine}
        {terminal || rows.length === 0 ? null : (
          <Box flexDirection="row" columnGap={2} flexWrap="wrap">
            {DOTS.filter(d => rows.some(r => dotOf(r).id === d.id)).map(d => (
              <Text key={`dot:${d.id}`}>
                <Text color={d.hex}>● </Text>
                <Text dimColor>{d.label}</Text>
              </Text>
            ))}
          </Box>
        )}
        {error && !removalError ? <Text color="error">{error}</Text> : null}
        {snap ? snap.warnings.map(w => <Text color="warning">{w}</Text>) : null}
        {panelInGroup ? null : removalPanel}
        <Box flexDirection="column" gap={1}>
          {groupViews}
          {snap && !anyShown ? <Text dimColor>{query ? 'Nothing matches the search.' : 'Nothing in this filter.'}</Text> : null}
        </Box>
        {options}
      </Box>
    )
  })
}
