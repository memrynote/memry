export interface WorkspaceNote {
  id: string
  title: string
}

/** Device-local descriptor only. Note bodies are deliberately not persisted here. */
export interface WorkspaceTab {
  id: string
  destination: { kind: 'note'; noteId: string }
  title: string
  openedAt: number
  lastAccessedAt: number
}

export interface WorkspaceTabsState {
  tabs: readonly WorkspaceTab[]
  /** Null exactly when `tabs` is empty; otherwise always names one tab. */
  activeTabId: string | null
}

export const EMPTY_WORKSPACE_TABS: WorkspaceTabsState = { tabs: [], activeTabId: null }

function normalizedTitle(title: string): string {
  return title.trim() || 'Untitled'
}

function mostRecent(tabs: readonly WorkspaceTab[]): WorkspaceTab | undefined {
  let result: WorkspaceTab | undefined
  for (const tab of tabs) {
    if (!result || tab.lastAccessedAt > result.lastAccessedAt) result = tab
  }
  return result
}

/** Repairs persisted input into the module invariant and deduplicates notes by id. */
export function normalizeWorkspaceTabs(
  source: readonly WorkspaceTab[],
  requestedActiveTabId: string | null
): WorkspaceTabsState {
  const byNoteId = new Map<string, WorkspaceTab>()
  for (const tab of source) {
    const previous = byNoteId.get(tab.destination.noteId)
    if (!previous || tab.lastAccessedAt >= previous.lastAccessedAt) {
      byNoteId.set(tab.destination.noteId, tab)
    }
  }
  const tabs = [...byNoteId.values()].sort(
    (a, b) => a.openedAt - b.openedAt || a.id.localeCompare(b.id)
  )
  if (tabs.length === 0) return EMPTY_WORKSPACE_TABS
  const requested = requestedActiveTabId
    ? tabs.find((tab) => tab.id === requestedActiveTabId)
    : undefined
  return { tabs, activeTabId: (requested ?? mostRecent(tabs) ?? tabs[0])?.id ?? null }
}

/** Disk restores in the background; live registrations made meanwhile win. */
export function mergeWorkspaceTabs(
  stored: WorkspaceTabsState,
  live: WorkspaceTabsState
): WorkspaceTabsState {
  return normalizeWorkspaceTabs(
    [...stored.tabs, ...live.tabs],
    live.activeTabId ?? stored.activeTabId
  )
}

export function openWorkspaceNote(
  state: WorkspaceTabsState,
  note: WorkspaceNote,
  input: { tabId: string; now: number }
): WorkspaceTabsState {
  const existing = state.tabs.find((tab) => tab.destination.noteId === note.id)
  if (existing) {
    const tabs = state.tabs.map((tab) =>
      tab.id === existing.id
        ? { ...tab, title: normalizedTitle(note.title), lastAccessedAt: input.now }
        : tab
    )
    return normalizeWorkspaceTabs(tabs, existing.id)
  }
  const tab: WorkspaceTab = {
    id: input.tabId,
    destination: { kind: 'note', noteId: note.id },
    title: normalizedTitle(note.title),
    openedAt: input.now,
    lastAccessedAt: input.now
  }
  return { tabs: [...state.tabs, tab], activeTabId: tab.id }
}

export function activateWorkspaceTab(
  state: WorkspaceTabsState,
  tabId: string,
  now: number
): WorkspaceTabsState {
  if (!state.tabs.some((tab) => tab.id === tabId)) return state
  return {
    tabs: state.tabs.map((tab) => (tab.id === tabId ? { ...tab, lastAccessedAt: now } : tab)),
    activeTabId: tabId
  }
}

export function closeWorkspaceTab(state: WorkspaceTabsState, tabId: string): WorkspaceTabsState {
  const closingIndex = state.tabs.findIndex((tab) => tab.id === tabId)
  if (closingIndex < 0) return state
  const tabs = state.tabs.filter((tab) => tab.id !== tabId)
  if (tabs.length === 0) return EMPTY_WORKSPACE_TABS
  if (state.activeTabId !== tabId) return { tabs, activeTabId: state.activeTabId }

  // The card to the right slides into this slot; at the end, use the left neighbour.
  const nearest = tabs[Math.min(closingIndex, tabs.length - 1)]
  return { tabs, activeTabId: nearest?.id ?? mostRecent(tabs)?.id ?? null }
}
