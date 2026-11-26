export type WtSession = {
  id: string
  title: string
  archived: boolean
  lastActivity: number
  turns: number
  waiting: boolean
}

export type WtPr = {
  id: number
  title: string
  status: string
  draft: boolean
  url: string
  target: string
  lastSource: string
}

export type WtStatus =
  | 'main'
  | 'merged'
  | 'merged+'
  | 'pr'
  | 'pushed'
  | 'ahead'
  | 'local'
  | 'empty'
  | 'detached'
  | 'missing'

export type WtRow = {
  path: string
  name: string
  branch: string
  head: string
  detached: boolean
  main: boolean
  status: WtStatus
  detail: string
  commits: number
  unpushed: number
  behindRemote: number
  behindBase: number
  remote: boolean
  pr: WtPr | null
  files: number
  ins: number
  del: number
  dirtyFiles: number
  dirtyIns: number
  dirtyDel: number
  lastCommit: number
  sessions: WtSession[]
  /** Prunable, yet the folder is still there: a delete that stopped partway. */
  leftover?: boolean
}

/** Why PR status is missing or incomplete, from the scan's test call to the PR host. */
export type WtPrIssue = {
  kind: 'no-token' | 'no-gh' | 'unauthorized' | 'forbidden' | 'unreachable' | 'error' | 'partial'
  detail: string
}

/** Where PR status comes from, read off the origin URL. */
export type WtProvider = {
  kind: 'ado' | 'github' | 'none'
  /** 'Azure DevOps', 'GitHub', or the remote's host name. */
  name: string
  org: string
  web: string
  api: string
  home: string
  tokenPage: string
  /** Azure DevOps: the Windows Credential Manager entry holding the token. */
  tokenName: string
}

export type WtSnapshot = {
  generatedAt: number
  repo: string
  base: string
  prEnabled: boolean
  provider?: WtProvider
  prIssue?: WtPrIssue | null
  /** The config's folder patterns the panel can clean; empty lists hide cleaning. */
  build?: { dirs: string[]; binaries: string[] }
  warnings: string[]
  worktrees: WtRow[]
}

export type WtPrefs = {
  showArchived: boolean
  autoOpen: boolean
}

/** Groups the pane sorts worktrees into, in drawing order. */
export type WtGroup = 'needs' | 'review' | 'pushed' | 'done' | 'main'

export type WtFilter = 'all' | 'needs' | 'review' | 'done'

export type WtView = {
  filter: WtFilter
  search: string
  /** Worktree paths whose details are open. */
  expanded: string[]
  /** Groups drawn folded. */
  collapsed: WtGroup[]
}

/** Disk use of one worktree folder, links not followed. */
export type WtSize = {
  bytes: number
  at: number
  /** In the config's buildDirs. */
  obj?: number
  /** In the config's binaryDirs. */
  bin?: number
}

export type WtCleanItem = {
  path: string
  name: string
  obj: number
  bin: number
  /** Why cleaning it now is risky (a session is active there), or ''. */
  risk: string
}

/** The build-output clean dialog, opened from the disk line ('all') or one row (its path). */
export type WtClean = {
  origin: string
  items: WtCleanItem[]
  includeBin: boolean
  result: string
}

/** Keyed by the lower-case backslash path. */
export type WtSizes = Record<string, WtSize>

/** How far a script run is, from its "@progress" lines. */
export type WtProgress = {
  value: number
  max: number
  text: string
}

export type WtBranchAction = 'none' | 'safe' | 'force'

/** One worktree in the remove dialog, as remove-worktrees.ps1 judged it. */
export type WtCheck = {
  path: string
  name: string
  branch: string
  branchAction: WtBranchAction
  sessionIds: string[]
  ok: boolean
  reason: string
  bytes: number
}

export type WtConfirm = {
  items: WtCheck[]
  deleteBranches: boolean
  discardSubmodules: boolean
  archiveSessions: boolean
}

declare module 'claude-code' {
  interface PluginState {
    'worktrees-panel': {
      snapshot: Shaped<WtSnapshot | null>
      busy: string
      error: string
      notice: string
      prefs: Shaped<WtPrefs>
      selected: Shaped<string[]>
      confirm: Shaped<WtConfirm | null>
      view: Shaped<WtView>
      sizes: Shaped<WtSizes>
      sizing: boolean
      progress: Shaped<WtProgress | null>
      sizeProgress: Shaped<WtProgress | null>
      prIssueHidden: string
      clean: Shaped<WtClean | null>
    }
  }
}
