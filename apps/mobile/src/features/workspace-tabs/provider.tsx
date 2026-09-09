import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  useSyncExternalStore,
  type ReactNode
} from 'react'
import type { VaultDb } from '@/db/index'
import { createLogger } from '@/lib/logger'
import {
  EMPTY_WORKSPACE_TABS,
  activateWorkspaceTab,
  closeWorkspaceTab,
  normalizeWorkspaceTabs,
  openWorkspaceNote,
  type WorkspaceNote,
  type WorkspaceTab,
  type WorkspaceTabsState
} from './model'
import { createWorkspaceTabsStorage, type WorkspaceTabsStorage } from './storage'

const log = createLogger('WorkspaceTabs')

export class WorkspaceTabsStore {
  private state: WorkspaceTabsState = EMPTY_WORKSPACE_TABS
  private listeners = new Set<() => void>()
  private saveChain: Promise<void> = Promise.resolve()
  private hydrating = false
  private closedDuringHydration = new Set<string>()
  private hydrationPromise: Promise<void> | null = null

  constructor(private readonly storage: WorkspaceTabsStorage | null) {}

  private navigate: WorkspaceTabsNavigate = () => undefined

  setNavigate(navigate: WorkspaceTabsNavigate): void {
    this.navigate = navigate
  }

  readonly getSnapshot = (): WorkspaceTabsState => this.state

  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  async hydrate(): Promise<void> {
    if (!this.storage) return
    if (this.hydrationPromise) return this.hydrationPromise
    this.hydrating = true
    const hydration = this.loadStoredTabs()
    this.hydrationPromise = hydration
    try {
      await hydration
    } finally {
      if (this.hydrationPromise === hydration) {
        this.hydrationPromise = null
        this.hydrating = false
        this.closedDuringHydration.clear()
      }
    }
  }

  private async loadStoredTabs(): Promise<void> {
    const storage = this.storage
    if (!storage) return
    try {
      const stored = await storage.load()
      const liveNoteIds = new Set(this.state.tabs.map((tab) => tab.destination.noteId))
      const storedOnly = stored.tabs.filter(
        (tab) =>
          !liveNoteIds.has(tab.destination.noteId) &&
          !this.closedDuringHydration.has(tab.destination.noteId)
      )
      // Registrations and taps can happen while SQLite is loading. Live state
      // wins conflicts, while disk-only tabs survive and the merged snapshot
      // is persisted again in case an early save raced ahead of this read.
      this.publish(
        normalizeWorkspaceTabs(
          [...storedOnly, ...this.state.tabs],
          this.state.activeTabId ?? stored.activeTabId
        )
      )
    } catch (error) {
      log.warn('Loading workspace tabs failed', { error: String(error) })
    }
  }

  readonly open = (note: WorkspaceNote): void => {
    this.register(note)
    // Opening a note is a step forward in time — a wiki-link tap, quick open,
    // a duplicate. It pushes so Back returns to whatever the reader came from,
    // note or folder, instead of the new note's parent folder.
    this.navigate(note.id, 'push')
  }

  readonly register = (note: WorkspaceNote): void => {
    this.closedDuringHydration.delete(note.id)
    const next = openWorkspaceNote(this.state, note, {
      // A note can exist in this tab set once, so its semantic identity is a
      // stronger and more portable tab id than a runtime-specific UUID API.
      tabId: `note:${note.id}`,
      now: Date.now()
    })
    this.publish(next)
  }

  readonly activate = (tabId: string): void => {
    if (this.state.activeTabId === tabId) return
    const tab = this.state.tabs.find((candidate) => candidate.id === tabId)
    if (!tab) return
    this.publish(activateWorkspaceTab(this.state, tabId, Date.now()))
    // Switching or closing tabs is not travel: it swaps what the current stack
    // entry shows and leaves the history behind it intact.
    this.navigate(tab.destination.noteId, 'replace')
  }

  readonly close = (tabId: string): void => {
    const wasActive = this.state.activeTabId === tabId
    const closing = this.state.tabs.find((tab) => tab.id === tabId)
    const next = closeWorkspaceTab(this.state, tabId)
    if (next === this.state) return
    if (this.hydrating && closing) {
      this.closedDuringHydration.add(closing.destination.noteId)
    }
    this.publish(next)
    if (!wasActive) return
    const active = next.tabs.find((tab) => tab.id === next.activeTabId)
    this.navigate(active?.destination.noteId ?? null, 'replace')
  }

  flush(): Promise<void> {
    return this.saveChain
  }

  private publish(next: WorkspaceTabsState, persist = true): void {
    this.state = next
    for (const listener of this.listeners) listener()

    const storage = this.storage
    if (!persist || !storage) return
    this.saveChain = this.saveChain
      .catch(() => undefined)
      .then(() => storage.save(next))
      .catch((error) => {
        log.warn('Saving workspace tabs failed', { error: String(error) })
      })
  }
}

interface WorkspaceTabsContextValue {
  store: WorkspaceTabsStore
  visible: boolean
  setVisible: (visible: boolean) => void
}

/** `push` moves forward in history; `replace` swaps the current entry. */
export type WorkspaceTabsNavigate = (noteId: string | null, mode: 'push' | 'replace') => void

const WorkspaceTabsContext = createContext<WorkspaceTabsContextValue | null>(null)

export interface WorkspaceTabsProviderProps {
  db: VaultDb | null
  navigate: WorkspaceTabsNavigate
  children: ReactNode
}

export function WorkspaceTabsProvider({ db, navigate, children }: WorkspaceTabsProviderProps) {
  const store = useMemo(
    () => new WorkspaceTabsStore(db ? createWorkspaceTabsStorage(db) : null),
    [db]
  )
  const [visible, setVisible] = useState(false)

  useEffect(() => store.setNavigate(navigate), [navigate, store])

  useEffect(() => {
    void store.hydrate()
    return () => {
      void store.flush()
    }
  }, [store])

  const value = { store, visible, setVisible }
  return <WorkspaceTabsContext.Provider value={value}>{children}</WorkspaceTabsContext.Provider>
}

export interface WorkspaceTabsValue {
  tabs: readonly WorkspaceTab[]
  activeTabId: string | null
  open: (note: WorkspaceNote) => void
  register: (note: WorkspaceNote) => void
  activate: (tabId: string) => void
  close: (tabId: string) => void
  visible: boolean
  setVisible: (visible: boolean) => void
}

export function useWorkspaceTabs(): WorkspaceTabsValue {
  const context = useContext(WorkspaceTabsContext)
  if (!context) throw new Error('useWorkspaceTabs must be used inside WorkspaceTabsProvider')
  const state = useSyncExternalStore(context.store.subscribe, context.store.getSnapshot)
  const open = useCallback((note: WorkspaceNote) => context.store.open(note), [context.store])
  const register = useCallback(
    (note: WorkspaceNote) => context.store.register(note),
    [context.store]
  )
  const activate = useCallback((tabId: string) => context.store.activate(tabId), [context.store])
  const close = useCallback((tabId: string) => context.store.close(tabId), [context.store])
  return {
    ...state,
    open,
    register,
    activate,
    close,
    visible: context.visible,
    setVisible: context.setVisible
  }
}
