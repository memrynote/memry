// The launch's restored active tab, read straight out of localStorage.
//
// Read from storage rather than asked over IPC because the vault path is not
// available synchronously in the renderer, and a synchronous round-trip here
// would put back the one a sibling issue just removed from this spot. Tab state
// is written under `memry_tab_state` (legacy, global) and
// `memry_tab_state:<vaultPath>`, so with no vault path to key on this picks the
// entry with the largest `savedAt`. Guessing wrong costs one speculative chunk
// fetch and nothing else.
import { prefetchPageModule } from '@/components/split-view/tab-content'
import { STORAGE_KEY } from '@/contexts/tabs/persistence'
import type { PersistedTabGroup, PersistedTabState } from '@/contexts/tabs/persistence'
import type { TabType } from '@/contexts/tabs/types'
import { trackNoteReadable } from './telemetry-diagnostics'

/** Read by `scripts/launch-bench.mjs` over CDP; renaming it breaks that bench. */
export const NOTE_READABLE_MARK = 'memry:note-readable'

export const readRestoredActiveTab = (): { type: string; entityId?: string } | null => {
  try {
    let newest: Partial<PersistedTabState> | null = null
    let newestSavedAt = Number.NEGATIVE_INFINITY

    for (let index = 0; index < localStorage.length; index += 1) {
      const key = localStorage.key(index)
      if (!key?.startsWith(STORAGE_KEY)) continue

      const raw = localStorage.getItem(key)
      if (!raw) continue

      let parsed: Partial<PersistedTabState>
      try {
        parsed = JSON.parse(raw) as Partial<PersistedTabState>
      } catch {
        continue
      }

      const savedAt = parsed?.savedAt
      if (typeof savedAt !== 'number' || savedAt <= newestSavedAt) continue

      newest = parsed
      newestSavedAt = savedAt
    }

    if (!newest?.activeGroupId) return null

    const groups = newest.tabGroups as Record<string, PersistedTabGroup | undefined> | undefined
    const group = groups?.[newest.activeGroupId]
    if (!group?.activeTabId) return null

    const tab = group.tabs?.find((candidate) => candidate.id === group.activeTabId)
    return tab ? { type: tab.type, entityId: tab.entityId } : null
  } catch {
    return null
  }
}

const restoredTab = readRestoredActiveTab()

export const LAUNCH_NOTE_ID: string | null =
  restoredTab?.type === 'note' ? (restoredTab.entityId ?? null) : null

const PREFETCH_KEYS: Partial<Record<TabType, string>> = {
  home: 'home',
  inbox: 'inbox',
  calendar: 'calendar',
  journal: 'journal',
  tasks: 'tasks',
  'all-tasks': 'tasks',
  today: 'tasks',
  completed: 'tasks',
  project: 'project',
  note: 'note',
  file: 'file',
  folder: 'folderView',
  tag: 'folderView',
  'template-editor': 'templateEditor',
  graph: 'graph',
  tags: 'tagsHub',
  'agent-chat': 'agentConversation',
  canvas: 'canvas',
  'virtual-note': 'virtualNote'
}

export const prefetchRestoredTabPage = (): void => {
  if (!restoredTab) return
  const key = PREFETCH_KEYS[restoredTab.type as TabType]
  if (key) prefetchPageModule(key)
}

let noteReadableMarked = false

export const markLaunchNoteReadable = (noteId: string | null | undefined): void => {
  if (noteReadableMarked) return
  // Only the note this launch restored counts. Without the equality check, a
  // user who launches to the home tab and opens a note ten minutes later would
  // stamp that as the launch metric.
  if (!noteId || noteId !== LAUNCH_NOTE_ID) return

  noteReadableMarked = true
  if (typeof performance?.mark !== 'function') return

  performance.mark(NOTE_READABLE_MARK)
  trackNoteReadable(performance.now())
}
