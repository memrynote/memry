import { contextBridge, ipcRenderer, webUtils } from 'electron'
import { electronAPI } from '@electron-toolkit/preload'

// Import channel constants from shared (single source of truth)
import {
  VaultChannels,
  SavedFiltersChannels,
  TemplatesChannels,
  JournalChannels,
  SettingsChannels,
  BookmarksChannels,
  TagsChannels,
  ReminderChannels,
  FolderViewChannels,
  PropertiesChannels,
  SearchChannels,
  GraphChannels,
  AccountChannels
} from '@memry/contracts/ipc-channels'
import { SYNC_CHANNELS, SYNC_EVENTS } from '@memry/contracts/ipc-sync'
import { createGeneratedRpcApi } from './generated-rpc'
import type {
  SyncStatusChangedEvent,
  ItemSyncedEvent,
  ConflictDetectedEvent,
  LinkingRequestEvent,
  LinkingApprovedEvent,
  LinkingFinalizedEvent,
  UploadProgressEvent,
  DownloadProgressEvent,
  InitialSyncProgressEvent,
  QueueClearedEvent,
  SyncPausedEvent,
  SyncResumedEvent,
  KeyRotationProgressEvent,
  SessionExpiredEvent,
  OtpDetectedEvent,
  OAuthCallbackEvent,
  OAuthErrorEvent,
  ClockSkewWarningEvent,
  DeviceRevokedEvent,
  SecurityWarningEvent,
  CertificatePinFailedEvent
} from '@memry/contracts/ipc-sync'
import type {
  MainIpcInvokeChannel,
  MainIpcInvokeArgs,
  MainIpcInvokeResult
} from '../main/ipc/generated-ipc-invoke-map'

function invoke<C extends MainIpcInvokeChannel>(
  channel: C,
  ...args: MainIpcInvokeArgs<C>
): Promise<MainIpcInvokeResult<C>> {
  return ipcRenderer.invoke(channel, ...args) as Promise<MainIpcInvokeResult<C>>
}

function invokeSync(channel: string): unknown {
  return ipcRenderer.sendSync(channel)
}

function subscribe<T>(channel: string, callback: (payload: T) => void): () => void {
  const handler = (_event: Electron.IpcRendererEvent, payload: T): void => callback(payload)
  ipcRenderer.on(channel, handler)
  return () => ipcRenderer.removeListener(channel, handler)
}

type StartupTheme = 'light' | 'dark' | 'white' | 'system'
const THEME_STORAGE_KEY = 'memry-theme'

function getStartupThemeSync(): StartupTheme {
  // Fast path: use the theme cached in localStorage from the previous run.
  // This avoids a synchronous IPC round-trip on every launch after the first.
  try {
    const cached = window.localStorage.getItem(THEME_STORAGE_KEY)
    if (cached === 'light' || cached === 'dark' || cached === 'white' || cached === 'system') {
      return cached
    }
  } catch {
    // localStorage may be unavailable; fall through to IPC
  }
  // First launch (or corrupted storage): fall back to synchronous IPC.
  // The main-process handler returns `{ theme, accentColor? }`, so unwrap it
  // and validate. Treating the object as a string here would propagate
  // `[object Object]` into next-themes' localStorage and crash the renderer.
  try {
    const raw = ipcRenderer.sendSync(SettingsChannels.sync.GET_STARTUP_THEME) as
      | StartupTheme
      | { theme?: StartupTheme }
      | null
      | undefined
    const value = typeof raw === 'string' ? raw : raw?.theme
    if (value === 'light' || value === 'dark' || value === 'white' || value === 'system') {
      return value
    }
  } catch {
    // fall through
  }
  return 'system'
}

function resolveStartupTheme(theme: StartupTheme): 'light' | 'dark' | 'white' {
  if (theme === 'system') {
    return typeof globalThis.window !== 'undefined' &&
      typeof window.matchMedia === 'function' &&
      window.matchMedia('(prefers-color-scheme: dark)').matches
      ? 'dark'
      : 'light'
  }

  return theme
}

function applyStartupTheme(savedTheme: StartupTheme): void {
  const resolvedTheme = resolveStartupTheme(savedTheme)

  const applyToRoot = (): boolean => {
    const root = document.documentElement
    if (!root) return false

    root.classList.remove('dark', 'white')
    if (resolvedTheme === 'dark') root.classList.add('dark')
    if (resolvedTheme === 'white') root.classList.add('white')
    root.style.colorScheme = resolvedTheme === 'dark' ? 'dark' : 'light'
    return true
  }

  if (!applyToRoot()) {
    window.addEventListener(
      'DOMContentLoaded',
      () => {
        applyToRoot()
      },
      { once: true }
    )
  }
}

if (typeof globalThis.window !== 'undefined') {
  const startupTheme = getStartupThemeSync()
  try {
    window.localStorage.setItem(THEME_STORAGE_KEY, startupTheme)
  } catch {
    // localStorage may be unavailable in some test or restricted environments
  }
  applyStartupTheme(startupTheme)
}

const generatedRpcApi = createGeneratedRpcApi({
  invoke,
  invokeSync,
  subscribe
})

// Custom APIs for renderer
export const api = {
  // Window controls for custom traffic lights
  windowMinimize: (): void => ipcRenderer.send('window-minimize'),
  windowMaximize: (): void => ipcRenderer.send('window-maximize'),
  windowClose: (): void => ipcRenderer.send('window-close'),

  // File drop utility — resolves real filesystem paths from dropped File objects
  // (File.path is empty with contextIsolation; webUtils.getPathForFile is the replacement)
  getFileDropPaths: (files: File[]): string[] => files.map((f) => webUtils.getPathForFile(f)),

  // Generated domain RPC APIs
  ...generatedRpcApi,
  settings: {
    ...generatedRpcApi.settings,
    getStartupThemeSync
  },

  // Vault API
  vault: {
    select: (path?: string) => invoke(VaultChannels.invoke.SELECT, { path }),
    create: (path: string, _name: string) => invoke(VaultChannels.invoke.SELECT, { path }),
    getAll: () => invoke(VaultChannels.invoke.GET_ALL),
    getStatus: () => invoke(VaultChannels.invoke.GET_STATUS),
    getConfig: () => invoke(VaultChannels.invoke.GET_CONFIG),
    updateConfig: (config: Record<string, unknown>) =>
      invoke(VaultChannels.invoke.UPDATE_CONFIG, config),
    close: () => invoke(VaultChannels.invoke.CLOSE),
    switch: (vaultPath: string) => invoke(VaultChannels.invoke.SWITCH, vaultPath),
    remove: (vaultPath: string) => invoke(VaultChannels.invoke.REMOVE, vaultPath),
    reindex: () => invoke(VaultChannels.invoke.REINDEX),
    reveal: () => invoke(VaultChannels.invoke.REVEAL)
  },

  // Unified Properties API (works with notes and journal entries)
  properties: {
    get: (entityId: string) => invoke(PropertiesChannels.invoke.GET, { entityId }),
    set: (entityId: string, properties: Record<string, unknown>) =>
      invoke(PropertiesChannels.invoke.SET, { entityId, properties }),
    rename: (entityId: string, oldName: string, newName: string) =>
      invoke(PropertiesChannels.invoke.RENAME, { entityId, oldName, newName })
  },

  // Templates API
  templates: {
    list: () => invoke(TemplatesChannels.invoke.LIST),
    get: (id: string) => invoke(TemplatesChannels.invoke.GET, id),
    create: (input: {
      name: string
      description?: string
      icon?: string | null
      tags?: string[]
      properties?: Array<{
        name: string
        type: string
        value: unknown
        options?: string[]
      }>
      content?: string
    }) =>
      invoke(
        TemplatesChannels.invoke.CREATE,
        input as MainIpcInvokeArgs<typeof TemplatesChannels.invoke.CREATE>[0]
      ),
    update: (input: {
      id: string
      name?: string
      description?: string
      icon?: string | null
      tags?: string[]
      properties?: Array<{
        name: string
        type: string
        value: unknown
        options?: string[]
      }>
      content?: string
    }) =>
      invoke(
        TemplatesChannels.invoke.UPDATE,
        input as MainIpcInvokeArgs<typeof TemplatesChannels.invoke.UPDATE>[0]
      ),
    delete: (id: string) => invoke(TemplatesChannels.invoke.DELETE, id),
    duplicate: (id: string, newName: string) =>
      invoke(TemplatesChannels.invoke.DUPLICATE, { id, newName })
  },

  // Saved Filters API
  savedFilters: {
    list: () => invoke(SavedFiltersChannels.invoke.LIST),
    create: (input: { name: string; config: unknown }) =>
      invoke(
        SavedFiltersChannels.invoke.CREATE,
        input as MainIpcInvokeArgs<typeof SavedFiltersChannels.invoke.CREATE>[0]
      ),
    update: (input: { id: string; name?: string; config?: unknown; position?: number }) =>
      invoke(
        SavedFiltersChannels.invoke.UPDATE,
        input as MainIpcInvokeArgs<typeof SavedFiltersChannels.invoke.UPDATE>[0]
      ),
    delete: (id: string) => invoke(SavedFiltersChannels.invoke.DELETE, { id }),
    reorder: (ids: string[], positions: number[]) =>
      invoke(SavedFiltersChannels.invoke.REORDER, { ids, positions })
  },

  // Journal API
  journal: {
    // Entry CRUD
    getEntry: (date: string) => invoke(JournalChannels.invoke.GET_ENTRY, { date }),
    createEntry: (input: { date: string; content?: string; tags?: string[] }) =>
      invoke(JournalChannels.invoke.CREATE_ENTRY, input),
    updateEntry: (input: { date: string; content?: string; tags?: string[] }) =>
      invoke(JournalChannels.invoke.UPDATE_ENTRY, input),
    deleteEntry: (date: string) => invoke(JournalChannels.invoke.DELETE_ENTRY, { date }),

    // Calendar & Views
    getHeatmap: (year: number) => invoke(JournalChannels.invoke.GET_HEATMAP, { year }),
    getMonthEntries: (year: number, month: number) =>
      invoke(JournalChannels.invoke.GET_MONTH_ENTRIES, { year, month }),
    getYearStats: (year: number) => invoke(JournalChannels.invoke.GET_YEAR_STATS, { year }),

    // Context
    getDayContext: (date: string) => invoke(JournalChannels.invoke.GET_DAY_CONTEXT, { date }),

    // Tags
    getAllTags: () => invoke(JournalChannels.invoke.GET_ALL_TAGS),

    // Streak
    getStreak: () => invoke(JournalChannels.invoke.GET_STREAK)
  },

  // Bookmarks API
  bookmarks: {
    /** Create a new bookmark */
    create: (input: { itemType: string; itemId: string }) =>
      invoke(BookmarksChannels.invoke.CREATE, input),
    /** Delete a bookmark by ID */
    delete: (id: string) => invoke(BookmarksChannels.invoke.DELETE, id),
    /** Get a bookmark by ID */
    get: (id: string) => invoke(BookmarksChannels.invoke.GET, id),
    /** List bookmarks with optional filters */
    list: (options?: {
      itemType?: string
      sortBy?: 'position' | 'createdAt'
      sortOrder?: 'asc' | 'desc'
      limit?: number
      offset?: number
    }) => invoke(BookmarksChannels.invoke.LIST, options ?? {}),
    /** Check if an item is bookmarked */
    isBookmarked: (input: { itemType: string; itemId: string }) =>
      invoke(BookmarksChannels.invoke.IS_BOOKMARKED, input),
    /** Toggle bookmark status (create or delete) */
    toggle: (input: { itemType: string; itemId: string }) =>
      invoke(BookmarksChannels.invoke.TOGGLE, input),
    /** Reorder bookmarks */
    reorder: (bookmarkIds: string[]) => invoke(BookmarksChannels.invoke.REORDER, { bookmarkIds }),
    /** List bookmarks by item type */
    listByType: (itemType: string) => invoke(BookmarksChannels.invoke.LIST_BY_TYPE, itemType),
    /** Get bookmark for a specific item */
    getByItem: (input: { itemType: string; itemId: string }) =>
      invoke(BookmarksChannels.invoke.GET_BY_ITEM, input),
    /** Delete multiple bookmarks */
    bulkDelete: (bookmarkIds: string[]) =>
      invoke(BookmarksChannels.invoke.BULK_DELETE, { bookmarkIds }),
    /** Create multiple bookmarks */
    bulkCreate: (items: Array<{ itemType: string; itemId: string }>) =>
      invoke(BookmarksChannels.invoke.BULK_CREATE, { items })
  },

  // Graph API
  graph: {
    getData: () => invoke(GraphChannels.invoke.GET_GRAPH_DATA),
    getLocal: (params: { noteId: string; depth?: number }) =>
      invoke(GraphChannels.invoke.GET_LOCAL_GRAPH, params)
  },

  // Search API
  search: {
    query: (params: {
      text: string
      types?: Array<'note' | 'journal' | 'task' | 'inbox'>
      tags?: string[]
      dateRange?: { from: string; to: string } | null
      projectId?: string | null
      folderPath?: string | null
      limit?: number
      offset?: number
    }) => invoke(SearchChannels.invoke.QUERY, params),
    quick: (text: string) => invoke(SearchChannels.invoke.QUICK, text),
    getStats: () => invoke(SearchChannels.invoke.GET_STATS),
    rebuildIndex: () => invoke(SearchChannels.invoke.REBUILD_INDEX),
    getReasons: () => invoke(SearchChannels.invoke.GET_REASONS),
    addReason: (params: {
      itemId: string
      itemType: 'note' | 'journal' | 'task' | 'inbox'
      itemTitle: string
      searchQuery: string
    }) => invoke(SearchChannels.invoke.ADD_REASON, params),
    clearReasons: () => invoke(SearchChannels.invoke.CLEAR_REASONS),
    getAllTags: () => invoke(SearchChannels.invoke.GET_ALL_TAGS)
  },

  // Search event listeners
  onSearchIndexRebuildStarted: (callback: () => void): (() => void) => {
    const handler = (): void => callback()
    ipcRenderer.on(SearchChannels.events.INDEX_REBUILD_STARTED, handler)
    return () => ipcRenderer.removeListener(SearchChannels.events.INDEX_REBUILD_STARTED, handler)
  },

  onSearchIndexRebuildProgress: (
    callback: (progress: { phase: string; current: number; total: number; percent: number }) => void
  ): (() => void) => {
    const handler = (
      _event: Electron.IpcRendererEvent,
      data: { phase: string; current: number; total: number; percent: number }
    ): void => callback(data)
    ipcRenderer.on(SearchChannels.events.INDEX_REBUILD_PROGRESS, handler)
    return () => ipcRenderer.removeListener(SearchChannels.events.INDEX_REBUILD_PROGRESS, handler)
  },

  onSearchIndexRebuildCompleted: (callback: () => void): (() => void) => {
    const handler = (): void => callback()
    ipcRenderer.on(SearchChannels.events.INDEX_REBUILD_COMPLETED, handler)
    return () => ipcRenderer.removeListener(SearchChannels.events.INDEX_REBUILD_COMPLETED, handler)
  },

  onSearchIndexCorrupt: (callback: () => void): (() => void) => {
    const handler = (): void => callback()
    ipcRenderer.on(SearchChannels.events.INDEX_CORRUPT, handler)
    return () => ipcRenderer.removeListener(SearchChannels.events.INDEX_CORRUPT, handler)
  },

  // Quick Capture API (global shortcut window)
  quickCapture: {
    /** Close the quick capture window */
    close: (): void => ipcRenderer.send('quick-capture:close'),
    /** Get current clipboard text content */
    getClipboard: (): Promise<string> => invoke('quick-capture:get-clipboard'),
    /** Resize the quick capture window height */
    resize: (height: number): void => ipcRenderer.send('quick-capture:resize', height),
    /** Open the main settings modal to a section */
    openSettings: (section?: string): void =>
      ipcRenderer.send('quick-capture:open-settings', section)
  },

  // Native context menu
  showContextMenu: (
    items: Array<{
      id: string
      label: string
      accelerator?: string
      disabled?: boolean
      type?: 'normal' | 'separator'
    }>
  ): Promise<string | null> => invoke('context-menu:show', items),

  // Tags API (for sidebar drill-down)
  tags: {
    /** Get notes for a specific tag with pinned status */
    getNotesByTag: (input: {
      tag: string
      sortBy?: 'modified' | 'created' | 'title'
      sortOrder?: 'asc' | 'desc'
      includeDescendants?: boolean
    }) => invoke(TagsChannels.invoke.GET_NOTES_BY_TAG, input),
    /** Pin a note to a tag */
    pinNoteToTag: (input: { noteId: string; tag: string }) =>
      invoke(TagsChannels.invoke.PIN_NOTE_TO_TAG, input),
    /** Unpin a note from a tag */
    unpinNoteFromTag: (input: { noteId: string; tag: string }) =>
      invoke(TagsChannels.invoke.UNPIN_NOTE_FROM_TAG, input),
    /** Rename a tag across all notes */
    renameTag: (input: { oldName: string; newName: string }) =>
      invoke(TagsChannels.invoke.RENAME_TAG, input),
    /** Update tag color */
    updateTagColor: (input: { tag: string; color: string }) =>
      invoke(TagsChannels.invoke.UPDATE_TAG_COLOR, input),
    /** Delete a tag from all notes */
    deleteTag: (tag: string) => invoke(TagsChannels.invoke.DELETE_TAG, tag),
    /** Remove tag from a specific note */
    removeTagFromNote: (input: { noteId: string; tag: string }) =>
      invoke(TagsChannels.invoke.REMOVE_TAG_FROM_NOTE, input),
    getAllWithCounts: () => invoke(TagsChannels.invoke.GET_ALL_WITH_COUNTS),
    mergeTag: (input: { source: string; target: string }) =>
      invoke(TagsChannels.invoke.MERGE_TAG, input)
  },

  // Reminders API
  reminders: {
    /** Create a new reminder */
    create: (input: {
      targetType: 'note' | 'journal' | 'highlight'
      targetId: string
      remindAt: string
      title?: string
      note?: string
      highlightText?: string
      highlightStart?: number
      highlightEnd?: number
    }) =>
      invoke(
        ReminderChannels.invoke.CREATE,
        input as MainIpcInvokeArgs<typeof ReminderChannels.invoke.CREATE>[0]
      ),

    /** Update an existing reminder */
    update: (input: {
      id: string
      remindAt?: string
      title?: string | null
      note?: string | null
    }) => invoke(ReminderChannels.invoke.UPDATE, input),

    /** Delete a reminder */
    delete: (id: string) => invoke(ReminderChannels.invoke.DELETE, id),

    /** Get a reminder by ID */
    get: (id: string) => invoke(ReminderChannels.invoke.GET, id),

    /** List reminders with optional filters */
    list: (options?: {
      targetType?: 'note' | 'journal' | 'highlight'
      targetId?: string
      status?: string | string[]
      fromDate?: string
      toDate?: string
      limit?: number
      offset?: number
    }) =>
      invoke(
        ReminderChannels.invoke.LIST,
        (options ?? {}) as MainIpcInvokeArgs<typeof ReminderChannels.invoke.LIST>[0]
      ),

    /** Get upcoming reminders (next N days) */
    getUpcoming: (days?: number) => invoke(ReminderChannels.invoke.GET_UPCOMING, days),

    /** Get due reminders */
    getDue: () => invoke(ReminderChannels.invoke.GET_DUE),

    /** Get reminders for a specific target */
    getForTarget: (input: { targetType: 'note' | 'journal' | 'highlight'; targetId: string }) =>
      invoke(ReminderChannels.invoke.GET_FOR_TARGET, input),

    /** Count pending reminders (for badge) */
    countPending: () => invoke(ReminderChannels.invoke.COUNT_PENDING),

    /** Dismiss a reminder */
    dismiss: (id: string) => invoke(ReminderChannels.invoke.DISMISS, id),

    /** Snooze a reminder to a later time */
    snooze: (input: { id: string; snoozeUntil: string }) =>
      invoke(ReminderChannels.invoke.SNOOZE, input),

    /** Bulk dismiss multiple reminders */
    bulkDismiss: (input: { reminderIds: string[] }) =>
      invoke(ReminderChannels.invoke.BULK_DISMISS, input)
  },

  // Event subscription helpers
  onVaultStatusChanged: (callback: (status: unknown) => void): (() => void) => {
    const handler = (_event: Electron.IpcRendererEvent, status: unknown): void => callback(status)
    ipcRenderer.on(VaultChannels.events.STATUS_CHANGED, handler)
    return () => ipcRenderer.removeListener(VaultChannels.events.STATUS_CHANGED, handler)
  },

  onVaultIndexProgress: (callback: (progress: number) => void): (() => void) => {
    const handler = (_event: Electron.IpcRendererEvent, progress: number): void =>
      callback(progress)
    ipcRenderer.on(VaultChannels.events.INDEX_PROGRESS, handler)
    return () => ipcRenderer.removeListener(VaultChannels.events.INDEX_PROGRESS, handler)
  },

  onVaultError: (callback: (error: string) => void): (() => void) => {
    const handler = (_event: Electron.IpcRendererEvent, error: string): void => callback(error)
    ipcRenderer.on(VaultChannels.events.ERROR, handler)
    return () => ipcRenderer.removeListener(VaultChannels.events.ERROR, handler)
  },

  onVaultIndexRecovered: (
    callback: (event: { reason: string; filesIndexed: number; duration: number }) => void
  ): (() => void) => {
    const handler = (
      _event: Electron.IpcRendererEvent,
      data: { reason: string; filesIndexed: number; duration: number }
    ): void => callback(data)
    ipcRenderer.on(VaultChannels.events.INDEX_RECOVERED, handler)
    return () => ipcRenderer.removeListener(VaultChannels.events.INDEX_RECOVERED, handler)
  },

  // Saved Filters event subscription helpers
  onSavedFilterCreated: (callback: (event: { savedFilter: unknown }) => void): (() => void) => {
    const handler = (_event: Electron.IpcRendererEvent, data: { savedFilter: unknown }): void =>
      callback(data)
    ipcRenderer.on(SavedFiltersChannels.events.CREATED, handler)
    return () => ipcRenderer.removeListener(SavedFiltersChannels.events.CREATED, handler)
  },

  onSavedFilterUpdated: (
    callback: (event: { id: string; savedFilter: unknown }) => void
  ): (() => void) => {
    const handler = (
      _event: Electron.IpcRendererEvent,
      data: { id: string; savedFilter: unknown }
    ): void => callback(data)
    ipcRenderer.on(SavedFiltersChannels.events.UPDATED, handler)
    return () => ipcRenderer.removeListener(SavedFiltersChannels.events.UPDATED, handler)
  },

  onSavedFilterDeleted: (callback: (event: { id: string }) => void): (() => void) => {
    const handler = (_event: Electron.IpcRendererEvent, data: { id: string }): void =>
      callback(data)
    ipcRenderer.on(SavedFiltersChannels.events.DELETED, handler)
    return () => ipcRenderer.removeListener(SavedFiltersChannels.events.DELETED, handler)
  },

  // Templates event subscription helpers
  onTemplateCreated: (callback: (event: { template: unknown }) => void): (() => void) => {
    const handler = (_event: Electron.IpcRendererEvent, data: { template: unknown }): void =>
      callback(data)
    ipcRenderer.on(TemplatesChannels.events.CREATED, handler)
    return () => ipcRenderer.removeListener(TemplatesChannels.events.CREATED, handler)
  },

  onTemplateUpdated: (
    callback: (event: { id: string; template: unknown }) => void
  ): (() => void) => {
    const handler = (
      _event: Electron.IpcRendererEvent,
      data: { id: string; template: unknown }
    ): void => callback(data)
    ipcRenderer.on(TemplatesChannels.events.UPDATED, handler)
    return () => ipcRenderer.removeListener(TemplatesChannels.events.UPDATED, handler)
  },

  onTemplateDeleted: (callback: (event: { id: string }) => void): (() => void) => {
    const handler = (_event: Electron.IpcRendererEvent, data: { id: string }): void =>
      callback(data)
    ipcRenderer.on(TemplatesChannels.events.DELETED, handler)
    return () => ipcRenderer.removeListener(TemplatesChannels.events.DELETED, handler)
  },

  // Journal event subscription helpers
  onJournalEntryCreated: (
    callback: (event: { date: string; entry: unknown }) => void
  ): (() => void) => {
    const handler = (
      _event: Electron.IpcRendererEvent,
      data: { date: string; entry: unknown }
    ): void => callback(data)
    ipcRenderer.on(JournalChannels.events.ENTRY_CREATED, handler)
    return () => ipcRenderer.removeListener(JournalChannels.events.ENTRY_CREATED, handler)
  },

  onJournalEntryUpdated: (
    callback: (event: { date: string; entry: unknown }) => void
  ): (() => void) => {
    const handler = (
      _event: Electron.IpcRendererEvent,
      data: { date: string; entry: unknown }
    ): void => callback(data)
    ipcRenderer.on(JournalChannels.events.ENTRY_UPDATED, handler)
    return () => ipcRenderer.removeListener(JournalChannels.events.ENTRY_UPDATED, handler)
  },

  onJournalEntryDeleted: (callback: (event: { date: string }) => void): (() => void) => {
    const handler = (_event: Electron.IpcRendererEvent, data: { date: string }): void =>
      callback(data)
    ipcRenderer.on(JournalChannels.events.ENTRY_DELETED, handler)
    return () => ipcRenderer.removeListener(JournalChannels.events.ENTRY_DELETED, handler)
  },

  onJournalExternalChange: (
    callback: (event: { date: string; type: 'modified' | 'deleted' }) => void
  ): (() => void) => {
    const handler = (
      _event: Electron.IpcRendererEvent,
      data: { date: string; type: 'modified' | 'deleted' }
    ): void => callback(data)
    ipcRenderer.on(JournalChannels.events.EXTERNAL_CHANGE, handler)
    return () => ipcRenderer.removeListener(JournalChannels.events.EXTERNAL_CHANGE, handler)
  },

  // Bookmarks event subscription helpers
  onBookmarkCreated: (callback: (event: { bookmark: unknown }) => void): (() => void) => {
    const handler = (_event: Electron.IpcRendererEvent, data: { bookmark: unknown }): void =>
      callback(data)
    ipcRenderer.on(BookmarksChannels.events.CREATED, handler)
    return () => ipcRenderer.removeListener(BookmarksChannels.events.CREATED, handler)
  },

  onBookmarkDeleted: (
    callback: (event: { id: string; itemType: string; itemId: string }) => void
  ): (() => void) => {
    const handler = (
      _event: Electron.IpcRendererEvent,
      data: { id: string; itemType: string; itemId: string }
    ): void => callback(data)
    ipcRenderer.on(BookmarksChannels.events.DELETED, handler)
    return () => ipcRenderer.removeListener(BookmarksChannels.events.DELETED, handler)
  },

  onBookmarksReordered: (callback: (event: { bookmarkIds: string[] }) => void): (() => void) => {
    const handler = (_event: Electron.IpcRendererEvent, data: { bookmarkIds: string[] }): void =>
      callback(data)
    ipcRenderer.on(BookmarksChannels.events.REORDERED, handler)
    return () => ipcRenderer.removeListener(BookmarksChannels.events.REORDERED, handler)
  },

  // Tags event subscription helpers
  onTagRenamed: (
    callback: (event: { oldName: string; newName: string; affectedNotes: number }) => void
  ): (() => void) => {
    const handler = (
      _event: Electron.IpcRendererEvent,
      data: { oldName: string; newName: string; affectedNotes: number }
    ): void => callback(data)
    ipcRenderer.on(TagsChannels.events.RENAMED, handler)
    return () => ipcRenderer.removeListener(TagsChannels.events.RENAMED, handler)
  },

  onTagColorUpdated: (callback: (event: { tag: string; color: string }) => void): (() => void) => {
    const handler = (
      _event: Electron.IpcRendererEvent,
      data: { tag: string; color: string }
    ): void => callback(data)
    ipcRenderer.on(TagsChannels.events.COLOR_UPDATED, handler)
    return () => ipcRenderer.removeListener(TagsChannels.events.COLOR_UPDATED, handler)
  },

  onTagDeleted: (
    callback: (event: { tag: string; affectedNotes: number }) => void
  ): (() => void) => {
    const handler = (
      _event: Electron.IpcRendererEvent,
      data: { tag: string; affectedNotes: number }
    ): void => callback(data)
    ipcRenderer.on(TagsChannels.events.DELETED, handler)
    return () => ipcRenderer.removeListener(TagsChannels.events.DELETED, handler)
  },

  onTagNotesChanged: (
    callback: (event: {
      tag: string
      noteId: string
      action: 'pinned' | 'unpinned' | 'removed' | 'added'
    }) => void
  ): (() => void) => {
    const handler = (
      _event: Electron.IpcRendererEvent,
      data: { tag: string; noteId: string; action: 'pinned' | 'unpinned' | 'removed' | 'added' }
    ): void => callback(data)
    ipcRenderer.on(TagsChannels.events.NOTES_CHANGED, handler)
    return () => ipcRenderer.removeListener(TagsChannels.events.NOTES_CHANGED, handler)
  },

  // Reminder event subscription helpers
  onReminderCreated: (callback: (event: { reminder: unknown }) => void): (() => void) => {
    const handler = (_event: Electron.IpcRendererEvent, data: { reminder: unknown }): void =>
      callback(data)
    ipcRenderer.on(ReminderChannels.events.CREATED, handler)
    return () => ipcRenderer.removeListener(ReminderChannels.events.CREATED, handler)
  },

  onReminderUpdated: (callback: (event: { reminder: unknown }) => void): (() => void) => {
    const handler = (_event: Electron.IpcRendererEvent, data: { reminder: unknown }): void =>
      callback(data)
    ipcRenderer.on(ReminderChannels.events.UPDATED, handler)
    return () => ipcRenderer.removeListener(ReminderChannels.events.UPDATED, handler)
  },

  onReminderDeleted: (
    callback: (event: { id: string; targetType: string; targetId: string }) => void
  ): (() => void) => {
    const handler = (
      _event: Electron.IpcRendererEvent,
      data: { id: string; targetType: string; targetId: string }
    ): void => callback(data)
    ipcRenderer.on(ReminderChannels.events.DELETED, handler)
    return () => ipcRenderer.removeListener(ReminderChannels.events.DELETED, handler)
  },

  onReminderDue: (
    callback: (event: { reminders: unknown[]; count: number }) => void
  ): (() => void) => {
    const handler = (
      _event: Electron.IpcRendererEvent,
      data: { reminders: unknown[]; count: number }
    ): void => callback(data)
    ipcRenderer.on(ReminderChannels.events.DUE, handler)
    return () => ipcRenderer.removeListener(ReminderChannels.events.DUE, handler)
  },

  onReminderDismissed: (callback: (event: { reminder: unknown }) => void): (() => void) => {
    const handler = (_event: Electron.IpcRendererEvent, data: { reminder: unknown }): void =>
      callback(data)
    ipcRenderer.on(ReminderChannels.events.DISMISSED, handler)
    return () => ipcRenderer.removeListener(ReminderChannels.events.DISMISSED, handler)
  },

  onReminderSnoozed: (callback: (event: { reminder: unknown }) => void): (() => void) => {
    const handler = (_event: Electron.IpcRendererEvent, data: { reminder: unknown }): void =>
      callback(data)
    ipcRenderer.on(ReminderChannels.events.SNOOZED, handler)
    return () => ipcRenderer.removeListener(ReminderChannels.events.SNOOZED, handler)
  },

  /** Subscribe to desktop notification click events - navigates to reminder target */
  onReminderClicked: (callback: (event: { reminder: unknown }) => void): (() => void) => {
    const handler = (_event: Electron.IpcRendererEvent, data: { reminder: unknown }): void =>
      callback(data)
    ipcRenderer.on(ReminderChannels.events.CLICKED, handler)
    return () => ipcRenderer.removeListener(ReminderChannels.events.CLICKED, handler)
  },

  // Folder View API (Bases-like database view)
  folderView: {
    /** Get folder view configuration */
    getConfig: (folderPath: string) => invoke(FolderViewChannels.invoke.GET_CONFIG, { folderPath }),
    /** Set/update folder view configuration */
    setConfig: (folderPath: string, config: Record<string, unknown>) =>
      invoke(FolderViewChannels.invoke.SET_CONFIG, { folderPath, config }),
    /** Get all views for a folder */
    getViews: (folderPath: string) => invoke(FolderViewChannels.invoke.GET_VIEWS, { folderPath }),
    /** Add or update a single view */
    setView: (folderPath: string, view: Record<string, unknown>) =>
      invoke(FolderViewChannels.invoke.SET_VIEW, { folderPath, view } as MainIpcInvokeArgs<
        typeof FolderViewChannels.invoke.SET_VIEW
      >[0]),
    /** Delete a view by name */
    deleteView: (folderPath: string, viewName: string) =>
      invoke(FolderViewChannels.invoke.DELETE_VIEW, { folderPath, viewName }),
    /** List notes in folder with property values */
    listWithProperties: (options: {
      folderPath: string
      properties?: string[]
      limit?: number
      offset?: number
    }) => invoke(FolderViewChannels.invoke.LIST_WITH_PROPERTIES, options),
    /** Get available properties for column selector */
    getAvailableProperties: (folderPath: string) =>
      invoke(FolderViewChannels.invoke.GET_AVAILABLE_PROPERTIES, { folderPath }),
    /** Get AI-powered folder suggestions for moving a note (Phase 27) */
    getFolderSuggestions: (noteId: string) =>
      invoke(FolderViewChannels.invoke.GET_FOLDER_SUGGESTIONS, { noteId }),
    /** Check if a folder exists (T115) */
    folderExists: (folderPath: string): Promise<boolean> =>
      invoke(FolderViewChannels.invoke.FOLDER_EXISTS, folderPath)
  },

  // Folder View event subscription helpers
  onFolderViewConfigUpdated: (
    callback: (event: { path: string; source: 'internal' | 'external' }) => void
  ): (() => void) => {
    const handler = (
      _event: Electron.IpcRendererEvent,
      data: { path: string; source: 'internal' | 'external' }
    ): void => callback(data)
    ipcRenderer.on(FolderViewChannels.events.CONFIG_UPDATED, handler)
    return () => ipcRenderer.removeListener(FolderViewChannels.events.CONFIG_UPDATED, handler)
  },

  // Sync Auth API
  syncAuth: {
    requestOtp: (input: { email: string }) => invoke(SYNC_CHANNELS.AUTH_REQUEST_OTP, input),
    verifyOtp: (input: { email: string; code: string }) =>
      invoke(SYNC_CHANNELS.AUTH_VERIFY_OTP, input),
    resendOtp: (input: { email: string }) => invoke(SYNC_CHANNELS.AUTH_RESEND_OTP, input),
    initOAuth: (input: { provider: 'google' }) => invoke(SYNC_CHANNELS.AUTH_INIT_OAUTH, input),
    refreshToken: () => invoke(SYNC_CHANNELS.AUTH_REFRESH_TOKEN),
    logout: () => invoke(SYNC_CHANNELS.AUTH_LOGOUT)
  },

  // Sync Setup API
  syncSetup: {
    setupFirstDevice: (input: { provider: 'google'; oauthToken: string; state: string }) =>
      invoke(SYNC_CHANNELS.SETUP_FIRST_DEVICE, input),
    setupNewAccount: () => invoke(SYNC_CHANNELS.SETUP_NEW_ACCOUNT),
    confirmRecoveryPhrase: (input: { confirmed: boolean }) =>
      invoke(SYNC_CHANNELS.CONFIRM_RECOVERY_PHRASE, input),
    getRecoveryPhrase: (): Promise<string | null> => invoke(SYNC_CHANNELS.GET_RECOVERY_PHRASE)
  },

  // Device Linking API
  syncLinking: {
    generateLinkingQr: () => invoke(SYNC_CHANNELS.GENERATE_LINKING_QR),
    linkViaQr: (input: { qrData: string; provider?: string; oauthToken?: string }) =>
      invoke(SYNC_CHANNELS.LINK_VIA_QR, input),
    linkViaRecovery: (input: { recoveryPhrase: string }) =>
      invoke(SYNC_CHANNELS.LINK_VIA_RECOVERY, input),
    approveLinking: (input: { sessionId: string }) => invoke(SYNC_CHANNELS.APPROVE_LINKING, input),
    getLinkingSas: (input: { sessionId: string }) => invoke(SYNC_CHANNELS.GET_LINKING_SAS, input),
    completeLinkingQr: (input: { sessionId: string }) =>
      invoke(SYNC_CHANNELS.COMPLETE_LINKING_QR, input)
  },

  // Account API
  account: {
    getInfo: () => invoke(AccountChannels.invoke.GET_INFO),
    signOut: () => invoke(AccountChannels.invoke.SIGN_OUT),
    getRecoveryKey: () => invoke(AccountChannels.invoke.GET_RECOVERY_KEY)
  },

  // Device Management API
  syncDevices: {
    getDevices: () => invoke(SYNC_CHANNELS.GET_DEVICES),
    removeDevice: (input: { deviceId: string }) => invoke(SYNC_CHANNELS.REMOVE_DEVICE, input),
    renameDevice: (input: { deviceId: string; newName: string }) =>
      invoke(SYNC_CHANNELS.RENAME_DEVICE, input)
  },

  // Sync Operations API
  syncOps: {
    getStatus: () => invoke(SYNC_CHANNELS.GET_STATUS),
    triggerSync: () => invoke(SYNC_CHANNELS.TRIGGER_SYNC),
    getHistory: (input: { limit?: number; offset?: number }) =>
      invoke(SYNC_CHANNELS.GET_HISTORY, input),
    getQueueSize: () => invoke(SYNC_CHANNELS.GET_QUEUE_SIZE),
    pause: () => invoke(SYNC_CHANNELS.PAUSE),
    resume: () => invoke(SYNC_CHANNELS.RESUME),
    updateSyncedSetting: (fieldPath: string, value: unknown) =>
      invoke(SYNC_CHANNELS.UPDATE_SYNCED_SETTING, { fieldPath, value }),
    getSyncedSettings: () => invoke(SYNC_CHANNELS.GET_SYNCED_SETTINGS),
    getStorageBreakdown: () => invoke(SYNC_CHANNELS.GET_STORAGE_BREAKDOWN)
  },

  // Crypto API
  crypto: {
    encryptItem: (input: {
      itemId: string
      type: 'note' | 'task' | 'project' | 'settings'
      content: Record<string, unknown>
      operation?: 'create' | 'update' | 'delete'
      deletedAt?: number
      metadata?: Record<string, unknown>
    }) => invoke(SYNC_CHANNELS.ENCRYPT_ITEM, input),
    decryptItem: (input: {
      itemId: string
      type: 'note' | 'task' | 'project' | 'settings'
      encryptedKey: string
      keyNonce: string
      encryptedData: string
      dataNonce: string
      signature: string
      operation?: 'create' | 'update' | 'delete'
      deletedAt?: number
      metadata?: Record<string, unknown>
    }) => invoke(SYNC_CHANNELS.DECRYPT_ITEM, input),
    verifySignature: (input: {
      itemId: string
      type: 'note' | 'task' | 'project' | 'settings'
      encryptedKey: string
      keyNonce: string
      encryptedData: string
      dataNonce: string
      signature: string
      operation?: 'create' | 'update' | 'delete'
      deletedAt?: number
      metadata?: Record<string, unknown>
    }) => invoke(SYNC_CHANNELS.VERIFY_SIGNATURE, input),
    rotateKeys: (input: { confirm: boolean }) => invoke(SYNC_CHANNELS.ROTATE_KEYS, input),
    getRotationProgress: () => invoke(SYNC_CHANNELS.GET_ROTATION_PROGRESS)
  },

  // Attachment Sync API
  syncAttachments: {
    upload: (input: { noteId: string; filePath: string }) =>
      invoke(SYNC_CHANNELS.UPLOAD_ATTACHMENT, input),
    getUploadProgress: (input: { sessionId: string }) =>
      invoke(SYNC_CHANNELS.GET_UPLOAD_PROGRESS, input),
    download: (input: { attachmentId: string; targetPath: string }) =>
      invoke(SYNC_CHANNELS.DOWNLOAD_ATTACHMENT, input),
    getDownloadProgress: (input: { attachmentId: string }) =>
      invoke(SYNC_CHANNELS.GET_DOWNLOAD_PROGRESS, input)
  },

  // CRDT channels are merged into SYNC_CHANNELS (single flat namespace for the preload bridge)
  syncCrdt: {
    openDoc: (input: { noteId: string }) => invoke(SYNC_CHANNELS.OPEN_DOC, input),
    closeDoc: (input: { noteId: string }) => invoke(SYNC_CHANNELS.CLOSE_DOC, input),
    applyUpdate: (input: { noteId: string; update: number[] }) =>
      invoke(SYNC_CHANNELS.APPLY_UPDATE, input),
    syncStep1: (input: { noteId: string; stateVector: number[] }) =>
      invoke(SYNC_CHANNELS.SYNC_STEP_1, input),
    syncStep2: (input: { noteId: string; diff: number[] }) =>
      invoke(SYNC_CHANNELS.SYNC_STEP_2, input)
  },
  onCrdtStateChanged: (
    callback: (data: { noteId: string; update: number[]; origin: string }) => void
  ): (() => void) => {
    const handler = (
      _event: Electron.IpcRendererEvent,
      data: { noteId: string; update: number[]; origin: string }
    ): void => callback(data)
    ipcRenderer.on(SYNC_EVENTS.STATE_CHANGED, handler)
    return () => ipcRenderer.removeListener(SYNC_EVENTS.STATE_CHANGED, handler)
  },

  // Sync event subscriptions
  onSyncStatusChanged: (callback: (event: SyncStatusChangedEvent) => void): (() => void) => {
    const handler = (_event: Electron.IpcRendererEvent, data: SyncStatusChangedEvent): void =>
      callback(data)
    ipcRenderer.on(SYNC_EVENTS.STATUS_CHANGED, handler)
    return () => ipcRenderer.removeListener(SYNC_EVENTS.STATUS_CHANGED, handler)
  },
  onItemSynced: (callback: (event: ItemSyncedEvent) => void): (() => void) => {
    const handler = (_event: Electron.IpcRendererEvent, data: ItemSyncedEvent): void =>
      callback(data)
    ipcRenderer.on(SYNC_EVENTS.ITEM_SYNCED, handler)
    return () => ipcRenderer.removeListener(SYNC_EVENTS.ITEM_SYNCED, handler)
  },
  onConflictDetected: (callback: (event: ConflictDetectedEvent) => void): (() => void) => {
    const handler = (_event: Electron.IpcRendererEvent, data: ConflictDetectedEvent): void =>
      callback(data)
    ipcRenderer.on(SYNC_EVENTS.CONFLICT_DETECTED, handler)
    return () => ipcRenderer.removeListener(SYNC_EVENTS.CONFLICT_DETECTED, handler)
  },
  onLinkingRequest: (callback: (event: LinkingRequestEvent) => void): (() => void) => {
    const handler = (_event: Electron.IpcRendererEvent, data: LinkingRequestEvent): void =>
      callback(data)
    ipcRenderer.on(SYNC_EVENTS.LINKING_REQUEST, handler)
    return () => ipcRenderer.removeListener(SYNC_EVENTS.LINKING_REQUEST, handler)
  },
  onLinkingApproved: (callback: (event: LinkingApprovedEvent) => void): (() => void) => {
    const handler = (_event: Electron.IpcRendererEvent, data: LinkingApprovedEvent): void =>
      callback(data)
    ipcRenderer.on(SYNC_EVENTS.LINKING_APPROVED, handler)
    return () => ipcRenderer.removeListener(SYNC_EVENTS.LINKING_APPROVED, handler)
  },
  onLinkingFinalized: (callback: (event: LinkingFinalizedEvent) => void): (() => void) => {
    const handler = (_event: Electron.IpcRendererEvent, data: LinkingFinalizedEvent): void =>
      callback(data)
    ipcRenderer.on(SYNC_EVENTS.LINKING_FINALIZED, handler)
    return () => ipcRenderer.removeListener(SYNC_EVENTS.LINKING_FINALIZED, handler)
  },
  onUploadProgress: (callback: (event: UploadProgressEvent) => void): (() => void) => {
    const handler = (_event: Electron.IpcRendererEvent, data: UploadProgressEvent): void =>
      callback(data)
    ipcRenderer.on(SYNC_EVENTS.UPLOAD_PROGRESS, handler)
    return () => ipcRenderer.removeListener(SYNC_EVENTS.UPLOAD_PROGRESS, handler)
  },
  onDownloadProgress: (callback: (event: DownloadProgressEvent) => void): (() => void) => {
    const handler = (_event: Electron.IpcRendererEvent, data: DownloadProgressEvent): void =>
      callback(data)
    ipcRenderer.on(SYNC_EVENTS.DOWNLOAD_PROGRESS, handler)
    return () => ipcRenderer.removeListener(SYNC_EVENTS.DOWNLOAD_PROGRESS, handler)
  },
  onInitialSyncProgress: (callback: (event: InitialSyncProgressEvent) => void): (() => void) => {
    const handler = (_event: Electron.IpcRendererEvent, data: InitialSyncProgressEvent): void =>
      callback(data)
    ipcRenderer.on(SYNC_EVENTS.INITIAL_SYNC_PROGRESS, handler)
    return () => ipcRenderer.removeListener(SYNC_EVENTS.INITIAL_SYNC_PROGRESS, handler)
  },
  onQueueCleared: (callback: (event: QueueClearedEvent) => void): (() => void) => {
    const handler = (_event: Electron.IpcRendererEvent, data: QueueClearedEvent): void =>
      callback(data)
    ipcRenderer.on(SYNC_EVENTS.QUEUE_CLEARED, handler)
    return () => ipcRenderer.removeListener(SYNC_EVENTS.QUEUE_CLEARED, handler)
  },
  onSyncPaused: (callback: (event: SyncPausedEvent) => void): (() => void) => {
    const handler = (_event: Electron.IpcRendererEvent, data: SyncPausedEvent): void =>
      callback(data)
    ipcRenderer.on(SYNC_EVENTS.PAUSED, handler)
    return () => ipcRenderer.removeListener(SYNC_EVENTS.PAUSED, handler)
  },
  onSyncResumed: (callback: (event: SyncResumedEvent) => void): (() => void) => {
    const handler = (_event: Electron.IpcRendererEvent, data: SyncResumedEvent): void =>
      callback(data)
    ipcRenderer.on(SYNC_EVENTS.RESUMED, handler)
    return () => ipcRenderer.removeListener(SYNC_EVENTS.RESUMED, handler)
  },
  onKeyRotationProgress: (callback: (event: KeyRotationProgressEvent) => void): (() => void) => {
    const handler = (_event: Electron.IpcRendererEvent, data: KeyRotationProgressEvent): void =>
      callback(data)
    ipcRenderer.on(SYNC_EVENTS.KEY_ROTATION_PROGRESS, handler)
    return () => ipcRenderer.removeListener(SYNC_EVENTS.KEY_ROTATION_PROGRESS, handler)
  },
  onSessionExpired: (callback: (event: SessionExpiredEvent) => void): (() => void) => {
    const handler = (_event: Electron.IpcRendererEvent, data: SessionExpiredEvent): void =>
      callback(data)
    ipcRenderer.on(SYNC_EVENTS.SESSION_EXPIRED, handler)
    return () => ipcRenderer.removeListener(SYNC_EVENTS.SESSION_EXPIRED, handler)
  },
  onDeviceRevoked: (callback: (event: DeviceRevokedEvent) => void): (() => void) => {
    const handler = (_event: Electron.IpcRendererEvent, data: DeviceRevokedEvent): void =>
      callback(data)
    ipcRenderer.on(SYNC_EVENTS.DEVICE_REMOVED, handler)
    return () => ipcRenderer.removeListener(SYNC_EVENTS.DEVICE_REMOVED, handler)
  },
  onOtpDetected: (callback: (event: OtpDetectedEvent) => void): (() => void) => {
    const handler = (_event: Electron.IpcRendererEvent, data: OtpDetectedEvent): void =>
      callback(data)
    ipcRenderer.on(SYNC_EVENTS.OTP_DETECTED, handler)
    return () => ipcRenderer.removeListener(SYNC_EVENTS.OTP_DETECTED, handler)
  },
  onOAuthCallback: (callback: (event: OAuthCallbackEvent) => void): (() => void) => {
    const handler = (_event: Electron.IpcRendererEvent, data: OAuthCallbackEvent): void =>
      callback(data)
    ipcRenderer.on(SYNC_EVENTS.OAUTH_CALLBACK, handler)
    return () => ipcRenderer.removeListener(SYNC_EVENTS.OAUTH_CALLBACK, handler)
  },
  onOAuthError: (callback: (event: OAuthErrorEvent) => void): (() => void) => {
    const handler = (_event: Electron.IpcRendererEvent, data: OAuthErrorEvent): void =>
      callback(data)
    ipcRenderer.on(SYNC_EVENTS.OAUTH_ERROR, handler)
    return () => ipcRenderer.removeListener(SYNC_EVENTS.OAUTH_ERROR, handler)
  },
  onClockSkewWarning: (callback: (event: ClockSkewWarningEvent) => void): (() => void) => {
    const handler = (_event: Electron.IpcRendererEvent, data: ClockSkewWarningEvent): void =>
      callback(data)
    ipcRenderer.on(SYNC_EVENTS.CLOCK_SKEW_WARNING, handler)
    return () => ipcRenderer.removeListener(SYNC_EVENTS.CLOCK_SKEW_WARNING, handler)
  },
  onSecurityWarning: (callback: (event: SecurityWarningEvent) => void): (() => void) => {
    const handler = (_event: Electron.IpcRendererEvent, data: SecurityWarningEvent): void =>
      callback(data)
    ipcRenderer.on(SYNC_EVENTS.SECURITY_WARNING, handler)
    return () => ipcRenderer.removeListener(SYNC_EVENTS.SECURITY_WARNING, handler)
  },
  onCertificatePinFailed: (callback: (event: CertificatePinFailedEvent) => void): (() => void) => {
    const handler = (_event: Electron.IpcRendererEvent, data: CertificatePinFailedEvent): void =>
      callback(data)
    ipcRenderer.on(SYNC_EVENTS.CERTIFICATE_PIN_FAILED, handler)
    return () => ipcRenderer.removeListener(SYNC_EVENTS.CERTIFICATE_PIN_FAILED, handler)
  },

  // Flush-on-quit protocol: main asks renderer to flush pending saves before shutdown
  onFlushRequested: (callback: () => void): (() => void) => {
    const handler = (): void => callback()
    ipcRenderer.on('app:request-flush', handler)
    return () => ipcRenderer.removeListener('app:request-flush', handler)
  },
  notifyFlushDone: (): void => {
    ipcRenderer.send('app:flush-done')
  }
}

// Use `contextBridge` APIs to expose Electron APIs to
// renderer only if context isolation is enabled, otherwise
// just add to the DOM global.
if (process.contextIsolated) {
  try {
    contextBridge.exposeInMainWorld('electron', electronAPI)
    contextBridge.exposeInMainWorld('api', api)
  } catch (error) {
    console.error(error)
  }
} else {
  ;(window as unknown as Record<string, unknown>).electron = electronAPI
  ;(window as unknown as Record<string, unknown>).api = api
}

export type API = typeof api
