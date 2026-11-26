import type { On } from 'claude-code'
import { expect, test } from 'claude-code/testing'

import type { WtProvider, WtSnapshot } from '../types'

const PANE = {
  plugin: 'worktrees-panel',
  component: 'Pane',
  requestId: 'worktrees',
  props: {
    title: 'Worktrees',
    isFocused: false,
    bodyColumns: 100,
    placement: 'dock',
    scroll: { offset: 0, bodyRows: 40 },
    view: {},
  },
} as const

const REPO = 'C:\\src\\app'
const ELSEWHERE = 'C:\\src\\app\\.claude\\worktrees\\elsewhere'
const PR_PATH = 'C:\\src\\app\\.claude\\worktrees\\quiet-river-0f8964'
const MERGED_PATH = 'C:\\src\\app\\.claude\\worktrees\\export-format'

const ADO: WtProvider = {
  kind: 'ado',
  name: 'Azure DevOps',
  org: 'acme',
  web: 'https://dev.azure.com/acme/App/_git/app',
  api: 'https://dev.azure.com/acme/App/_apis/git/repositories/app',
  home: 'https://dev.azure.com/acme/App',
  tokenPage: 'https://dev.azure.com/acme/_usersSettings/tokens',
  tokenName: 'worktrees-panel:ado:acme',
}

const GITHUB: WtProvider = {
  kind: 'github',
  name: 'GitHub',
  org: 'acme',
  web: 'https://github.com/acme/app',
  api: 'acme/app',
  home: 'https://github.com/acme/app',
  tokenPage: '',
  tokenName: '',
}

const SNAP: WtSnapshot = {
  generatedAt: 1795600000000,
  repo: REPO,
  base: 'origin/main',
  prEnabled: true,
  provider: GITHUB,
  build: { dirs: ['out/*/obj'], binaries: ['out/*/bin'] },
  warnings: ['PR query failed for 1 branch(es)'],
  worktrees: [
    {
      path: PR_PATH,
      name: 'quiet-river-0f8964',
      branch: 'alex/FasterExport',
      head: 'abc',
      detached: false,
      main: false,
      status: 'pr',
      detail: '',
      commits: 20,
      unpushed: 2,
      behindRemote: 0,
      behindBase: 40,
      remote: true,
      pr: {
        id: 812,
        title: 'Faster export',
        status: 'active',
        draft: true,
        url: 'https://github.com/acme/app/pull/812',
        target: 'main',
        lastSource: 'abc',
      },
      files: 30,
      ins: 3626,
      del: 4174,
      dirtyFiles: 2,
      dirtyIns: 10,
      dirtyDel: 1,
      lastCommit: 1795500000000,
      sessions: [
        { id: 'local_1', title: 'Faster export', archived: false, lastActivity: 1795590000000, turns: 4, waiting: true },
        { id: 'local_2', title: 'Old review', archived: true, lastActivity: 1795000000000, turns: 1, waiting: false },
      ],
    },
    {
      path: MERGED_PATH,
      name: 'export-format',
      branch: 'alex/ExportFormat',
      head: 'def',
      detached: false,
      main: false,
      status: 'merged',
      detail: '',
      commits: 2,
      unpushed: 2,
      behindRemote: 0,
      behindBase: 100,
      remote: false,
      pr: null,
      files: 3,
      ins: 72,
      del: 30,
      dirtyFiles: 0,
      dirtyIns: 0,
      dirtyDel: 0,
      lastCommit: 1795400000000,
      sessions: [],
    },
  ],
}

const SIZES = {
  [MERGED_PATH.toLowerCase()]: { bytes: 40 * 2 ** 30, at: 1795600000000 },
}

const BUILD_SIZES = {
  [MERGED_PATH.toLowerCase()]: { bytes: 40 * 2 ** 30, obj: 24 * 2 ** 30, bin: 5 * 2 ** 30, at: 1795600000000 },
  [PR_PATH.toLowerCase()]: { bytes: 30 * 2 ** 30, obj: 20 * 2 ** 30, bin: 4 * 2 ** 30, at: 1795600000000 },
}

// Seeds the stored state the pane reads; `busy` and `selected` stand for a running action.
function seed(on: On, opts: { snap?: WtSnapshot; sizes?: object; busy?: string; selected?: string[]; cwd?: string } = {}) {
  on('state.get', ($, e, next) => {
    if (e.key === 'snapshot') return { value: { value: { shape: 'snapshot-1', value: opts.snap ?? SNAP }, version: 1 } }
    if (opts.sizes && e.key === 'sizes') return { value: { value: { shape: 'sizes-1', value: opts.sizes }, version: 1 } }
    if (opts.busy && e.key === 'busy') return { value: { value: opts.busy, version: 1 } }
    if (opts.selected && e.key === 'selected') return { value: { value: { shape: 'selected-1', value: opts.selected }, version: 1 } }
    return next(e)
  })
  on('session.cwd', () => ({ value: opts.cwd ?? ELSEWHERE }))
}

test('worktrees are grouped, with the done group folded, on every surface', async ($, on) => {
  seed(on)
  for (const surface of ['terminal', 'desktop', 'vscode', 'mobile'] as const) {
    const ui = await $.ui.mount({ ...PANE, surface })

    // Uncommitted changes and a waiting session put the PR worktree under NEEDS YOU.
    expect(await ui.find({ type: 'Text', text: /^Needs you$/ })).toBeTruthy()
    // A status dot on desktop, its label as the tooltip; text on the terminal.
    expect(await ui.find({ type: 'Text', text: /draft #812/ })).toBeTruthy()
    expect(await ui.find({ type: 'Text', text: /commit 2 files/ })).toBeTruthy()
    if (surface !== 'terminal') expect((await ui.find({ type: 'Text', text: /^✎ 2$/ }))?.text).toBe('✎ 2')
    expect(await ui.find({ type: 'Text', text: /^Done, can remove$/ })).toBeTruthy()
    expect(await ui.find({ type: 'Text', text: /merged #/ })).toBeFalsy()
    expect(await ui.find({ type: 'Button', key: 'filter:needs' })).toBeTruthy()
    expect(await ui.find({ type: 'Text', text: /PR query failed/ })).toBeTruthy()
    await ui.unmount()
  }
})

test('unfolding the done group shows the removable worktree with a pick box', async ($, on) => {
  seed(on)
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })

  await ui.press({ key: 'fold:done' })
  expect(await ui.find({ type: 'Text', text: /merged #/ })).toBeTruthy()
  expect(await ui.find({ type: 'Text', text: /safe to remove/ })).toBeTruthy()
  expect(await ui.find({ type: 'Button', key: `pick:${MERGED_PATH}` })).toBeTruthy()
  expect(await ui.find({ type: 'Text', text: /Done, can remove: Merged PR/ })).toBeTruthy()
  // Uncommitted changes and a recent session: no pick box.
  expect(await ui.find({ type: 'Button', key: `pick:${PR_PATH}` })).toBeFalsy()
  await ui.unmount()
})

test('a row opens to its sessions and actions', async ($, on) => {
  seed(on)
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })

  expect(await ui.find({ type: 'Button', key: 'sess:local_1' })).toBeFalsy()
  await ui.press({ key: `row:${PR_PATH}` })
  expect(await ui.find({ type: 'Button', key: 'sess:local_1' })).toBeTruthy()
  expect(await ui.find({ type: 'Button', key: 'sess:local_2' })).toBeFalsy()
  expect(await ui.find({ type: 'Button', key: `arch:${PR_PATH}` })).toBeTruthy()
  expect(await ui.find({ type: 'Button', key: `copyb:${PR_PATH}` })).toBeTruthy()
  // Hover actions are drawn on desktop, revealed by the surface under the pointer.
  expect(await ui.find({ type: 'Button', key: `hs:${PR_PATH}` })).toBeTruthy()
  expect(await ui.find({ type: 'Text', text: /Open session: Faster export/ })).toBeTruthy()
  expect(await ui.find({ type: 'Text', text: /Copy path/ })).toBeTruthy()
  await ui.unmount()
})

test('the search narrows the list and ignores folding', async ($, on) => {
  seed(on)
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })

  await ui.input({ key: 'search', text: 'exportformat' })
  expect(await ui.find({ type: 'Text', text: /merged #/ })).toBeTruthy()
  expect(await ui.find({ type: 'Text', text: /draft #812/ })).toBeFalsy()
  await ui.input({ key: 'search', text: 'nothing-like-this' })
  expect(await ui.find({ type: 'Text', text: /Nothing matches/ })).toBeTruthy()
  await ui.unmount()
})

test('the filter chips show one group', async ($, on) => {
  seed(on)
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })

  await ui.press({ key: 'filter:done' })
  expect(await ui.find({ type: 'Text', text: /merged #/ })).toBeTruthy()
  expect(await ui.find({ type: 'Text', text: /^Needs you$/ })).toBeFalsy()
  await ui.unmount()
})

test('sizes show on rows, groups and the cleanup bar', async ($, on) => {
  seed(on, { sizes: SIZES })
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })

  expect(await ui.find({ type: 'Text', text: /^Done, can remove$/ })).toBeTruthy()
  expect(await ui.find({ type: 'Text', text: /1 · 40 GB/ })).toBeTruthy()
  expect(await ui.find({ type: 'Button', key: 'rm-done' })).toBeTruthy()
  expect(await ui.find({ type: 'Text', text: /done, can remove 40 GB/ })).toBeTruthy()
  await ui.unmount()
})

test('the widget shows actionable counts', async ($, on) => {
  seed(on, { sizes: SIZES })
  const ui = await $.ui.mount({ ...PANE, props: { ...PANE.props, placement: 'widget' }, surface: 'desktop' })

  expect((await ui.find({ type: 'Text', text: /need you/ }))?.text).toBe('1 need you')
  expect((await ui.find({ type: 'Text', text: /can go/ }))?.text).toBe('1 can go · 40 GB')
  expect(await ui.find({ type: 'Button', key: 'w-done' })).toBeTruthy()
  expect(await ui.find({ type: 'Text', text: /2 worktrees/ })).toBeTruthy()
  await ui.unmount()
})

test('an empty pane draws its toolbar', async ($, on) => {
  on('session.cwd', () => ({ value: REPO }))
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })

  expect((await ui.find({ type: 'Text', text: /No data yet/ }))?.text).toBe('No data yet.')
  expect(await ui.find({ type: 'Button', key: 'filter:all' })).toBeTruthy()
  await ui.unmount()
})

test('a running scan keeps the old list under a progress bar', async ($, on) => {
  seed(on, { busy: 'Refreshing...' })
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })

  expect(await ui.find({ type: 'Text', text: /Showing the scan from/ })).toBeTruthy()
  expect(await ui.find({ type: 'Text', text: /draft #812/ })).toBeTruthy()
  await ui.unmount()
})

test('a removal check shows its progress under the Done header and on the picked rows', async ($, on) => {
  seed(on, { busy: 'Checking 1 worktree before removal...', selected: [MERGED_PATH] })
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })

  // A removal is no scan: the list is not dimmed and no scan note shows.
  expect(await ui.find({ type: 'Text', text: /Showing the scan from/ })).toBeFalsy()
  await ui.press({ key: 'fold:done' })
  expect(await ui.find({ type: 'Text', text: /checking…/ })).toBeTruthy()
  await ui.unmount()
})

test('a partly deleted worktree reads as a leftover to remove', async ($, on) => {
  const leftover = { ...SNAP.worktrees[1]!, status: 'missing' as const, leftover: true, detail: 'partly deleted' }
  seed(on, { snap: { ...SNAP, worktrees: [leftover] } })
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })

  await ui.press({ key: 'fold:done' })
  expect(await ui.find({ type: 'Text', text: /leftover · partly deleted/ })).toBeTruthy()
  expect(await ui.find({ type: 'Text', text: /missing or leftover/ })).toBeTruthy()
  expect(await ui.find({ type: 'Text', text: /leftover files: remove/ })).toBeTruthy()
  expect(await ui.find({ type: 'Button', key: `pick:${MERGED_PATH}` })).toBeTruthy()
  await ui.unmount()
})

test('a missing Azure DevOps token shows how to fix it, in the pane and the widget', async ($, on) => {
  seed(on, { snap: { ...SNAP, provider: ADO, prEnabled: false, warnings: [], prIssue: { kind: 'no-token', detail: 'no token' } } })
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect(await ui.find({ type: 'Text', text: /no Azure DevOps token/ })).toBeTruthy()
  expect(await ui.find({ type: 'Text', text: /organization acme/ })).toBeTruthy()
  expect(await ui.find({ type: 'Button', key: 'pr-store' })).toBeTruthy()
  await ui.press({ key: 'pr-hide' })
  expect(await ui.find({ type: 'Text', text: /no Azure DevOps token/ })).toBeFalsy()
  await ui.unmount()

  const w = await $.ui.mount({ ...PANE, props: { ...PANE.props, placement: 'widget' }, surface: 'desktop' })
  expect(await w.find({ type: 'Button', key: 'w-pr' })).toBeTruthy()
  await w.unmount()
})

test('a missing GitHub CLI says how to install it, with no token button', async ($, on) => {
  seed(on, { snap: { ...SNAP, prEnabled: false, warnings: [], prIssue: { kind: 'no-gh', detail: 'gh is not on the PATH' } } })
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect(await ui.find({ type: 'Text', text: /the GitHub CLI is not installed/ })).toBeTruthy()
  expect(await ui.find({ type: 'Text', text: /winget install GitHub.cli/ })).toBeTruthy()
  expect(await ui.find({ type: 'Button', key: 'pr-store' })).toBeFalsy()
  await ui.unmount()
})

test('build output can be cleaned in idle worktrees or from one row', async ($, on) => {
  seed(on, { sizes: BUILD_SIZES })
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })

  expect(await ui.find({ type: 'Text', text: /build output 53 GB in 2 worktrees/ })).toBeTruthy()
  await ui.press({ key: 'clean-idle' })
  expect(await ui.find({ type: 'Text', text: /frees about 44 GB/ })).toBeTruthy()
  expect(await ui.find({ type: 'Text', text: /Deletes the build output \(out\/\*\/obj\)/ })).toBeTruthy()
  await ui.press({ key: 'clean-bin' })
  expect(await ui.find({ type: 'Text', text: /frees about 53 GB/ })).toBeTruthy()
  await ui.press({ key: 'clean-cancel' })
  expect(await ui.find({ type: 'Button', key: 'clean-go' })).toBeFalsy()

  await ui.press({ key: `row:${PR_PATH}` })
  await ui.press({ key: `clean:${PR_PATH}` })
  expect(await ui.find({ type: 'Text', text: /Clean build output in 1 worktree/ })).toBeTruthy()
  expect(await ui.find({ type: 'Button', key: 'clean-go' })).toBeTruthy()
  await ui.unmount()
})

test('without binary folders in the config the clean dialog offers no binaries', async ($, on) => {
  seed(on, { snap: { ...SNAP, build: { dirs: ['out/*/obj'], binaries: [] } }, sizes: BUILD_SIZES })
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })

  await ui.press({ key: 'clean-idle' })
  expect(await ui.find({ type: 'Button', key: 'clean-go' })).toBeTruthy()
  expect(await ui.find({ type: 'Button', key: 'clean-bin' })).toBeFalsy()
  await ui.unmount()
})
