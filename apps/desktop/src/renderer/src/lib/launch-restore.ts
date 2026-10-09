// The launch's restored active tab, read straight out of localStorage before
// React renders, so its page chunk can be prefetched and its note-readable mark
// matched to the right note.
//
// The key comes from the vault the window was created for (main passes it on
// the command line, see `@memry/contracts/startup-vault`), so a second vault's
// newer tab state can never be picked instead. Falls back to the legacy global
// key that `adoptLegacyState` hands to the first vault that opens.
import { prefetchPageModule } from '@/components/split-view/tab-content'
import { STORAGE_KEY, tabStateStorageKey } from '@/contexts/tabs/persistence'
import type { PersistedTabGroup, PersistedTabState } from '@/contexts/tabs/persistence'
import type { TabType } from '@/contexts/tabs/types'
import { vaultService } from '@/services/vault-service'
import { trackNoteReadable } from './telemetry-diagnostics'

/** Read by `scripts/launch-bench.mjs` over CDP; renaming it breaks that bench. */
export const NOTE_READABLE_MARK = 'memry:note-readable'

const readTabState = (key: string): Partial<PersistedTabState> | null => {
  const raw = localStorage.getItem(key)
  return raw ? (JSON.parse(raw) as Partial<PersistedTabState>) : null
}

export const readRestoredActiveTab = (): { type: string; entityId?: string } | null => {
  try {
    const vaultPath = vaultService.getStartupPath()
    if (!vaultPath) return null

    const state = readTabState(tabStateStorageKey(vaultPath)) ?? readTabState(STORAGE_KEY)
    if (!state?.activeGroupId) return null

    const groups = state.tabGroups as Record<string, PersistedTabGroup | undefined> | undefined
    const group = groups?.[state.activeGroupId]
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
