import { contextBridge, ipcRenderer, webUtils } from 'electron'
import { electronAPI } from '@electron-toolkit/preload'

// Import channel constants from shared (single source of truth)
import {
  VaultChannels,
  NotesChannels,
  SearchChannels,
  TasksChannels,
  SavedFiltersChannels,
  TemplatesChannels,
  JournalChannels,
  SettingsChannels,
  BookmarksChannels,
  TagsChannels,
  InboxChannels,
  ReminderChannels,
  FolderViewChannels,
  PropertiesChannels
} from '@shared/ipc-channels'
import { SYNC_CHANNELS, SYNC_EVENTS } from '@shared/contracts/ipc-sync'
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
} from '@shared/contracts/ipc-sync'
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

// Custom APIs for renderer
export const api = {
  // Window controls for custom traffic lights
  windowMinimize: (): void => ipcRenderer.send('window-minimize'),
  windowMaximize: (): void => ipcRenderer.send('window-maximize'),
  windowClose: (): void => ipcRenderer.send('window-close'),

  // File drop utility — resolves real filesystem paths from dropped File objects
  // (File.path is empty with contextIsolation; webUtils.getPathForFile is the replacement)
  getFileDropPaths: (files: File[]): string[] => files.map((f) => webUtils.getPathForFile(f)),

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
    reindex: () => invoke(VaultChannels.invoke.REINDEX)
  },

  // Notes API
  notes: {
    create: (input: { title: string; content?: string; folder?: string; tags?: string[] }) =>
      invoke(NotesChannels.invoke.CREATE, input),
    get: (id: string) => invoke(NotesChannels.invoke.GET, id),
    getByPath: (path: string) => invoke(NotesChannels.invoke.GET_BY_PATH, path),
    getFile: (id: string) => invoke(NotesChannels.invoke.GET_FILE, id),
    resolveByTitle: (title: string) => invoke(NotesChannels.invoke.RESOLVE_BY_TITLE, title),
    update: (input: {
      id: string
      title?: string
      content?: string
      tags?: string[]
      frontmatter?: Record<string, unknown>
      emoji?: string | null // T028: Emoji support
    }) => invoke(NotesChannels.invoke.UPDATE, input),
    rename: (id: string, newTitle: string) => invoke(NotesChannels.invoke.RENAME, { id, newTitle }),
    move: (id: string, newFolder: string) => invoke(NotesChannels.invoke.MOVE, { id, newFolder }),
    delete: (id: string) => invoke(NotesChannels.invoke.DELETE, id),
    list: (options?: {
      folder?: string
      tags?: string[]
      sortBy?: 'modified' | 'created' | 'title'
      sortOrder?: 'asc' | 'desc'
      limit?: number
      offset?: number
    }) => invoke(NotesChannels.invoke.LIST, options ?? {}),
    getTags: () => invoke(NotesChannels.invoke.GET_TAGS),
    getLinks: (id: string) => invoke(NotesChannels.invoke.GET_LINKS, id),
    getFolders: () => invoke(NotesChannels.invoke.GET_FOLDERS),
    createFolder: (path: string) => invoke(NotesChannels.invoke.CREATE_FOLDER, path),
    renameFolder: (oldPath: string, newPath: string) =>
      invoke(NotesChannels.invoke.RENAME_FOLDER, { oldPath, newPath }),
    deleteFolder: (path: string) => invoke(NotesChannels.invoke.DELETE_FOLDER, path),
    exists: (titleOrPath: string) => invoke(NotesChannels.invoke.EXISTS, titleOrPath),
    openExternal: (id: string) => invoke(NotesChannels.invoke.OPEN_EXTERNAL, id),
    revealInFinder: (id: string) => invoke(NotesChannels.invoke.REVEAL_IN_FINDER, id),

    // Property Definitions API (T017-T018)
    // Note: get/set properties moved to unified properties API
    getPropertyDefinitions: () => invoke(NotesChannels.invoke.GET_PROPERTY_DEFINITIONS),
    createPropertyDefinition: (input: {
      name: string
      type: string
      options?: string[]
      defaultValue?: unknown
      color?: string
    }) =>
      invoke(
        NotesChannels.invoke.CREATE_PROPERTY_DEFINITION,
        input as MainIpcInvokeArgs<typeof NotesChannels.invoke.CREATE_PROPERTY_DEFINITION>[0]
      ),
    updatePropertyDefinition: (input: {
      name: string
      type?: string
      options?: string[]
      defaultValue?: unknown
      color?: string
    }) =>
      invoke(
        NotesChannels.invoke.UPDATE_PROPERTY_DEFINITION,
        input as MainIpcInvokeArgs<typeof NotesChannels.invoke.UPDATE_PROPERTY_DEFINITION>[0]
      ),

    // T070: Attachments API
    uploadAttachment: (noteId: string, file: File) => {
      return new Promise((resolve, reject) => {
        const reader = new FileReader()
        reader.onload = () => {
          const arrayBuffer = reader.result as ArrayBuffer
          invoke(NotesChannels.invoke.UPLOAD_ATTACHMENT, {
            noteId,
            filename: file.name,
            data: Array.from(new Uint8Array(arrayBuffer))
          })
            .then(resolve)
            .catch(reject)
        }
        reader.onerror = () => reject(new Error('Failed to read file'))
        reader.readAsArrayBuffer(file)
      })
    },
    listAttachments: (noteId: string) => invoke(NotesChannels.invoke.LIST_ATTACHMENTS, noteId),
    deleteAttachment: (noteId: string, filename: string) =>
      invoke(NotesChannels.invoke.DELETE_ATTACHMENT, { noteId, filename }),

    // Folder config API (T096.5)
    getFolderConfig: (folderPath: string) =>
      invoke(NotesChannels.invoke.GET_FOLDER_CONFIG, folderPath),
    setFolderConfig: (folderPath: string, config: { template?: string; inherit?: boolean }) =>
      invoke(NotesChannels.invoke.SET_FOLDER_CONFIG, { folderPath, config }),
    getFolderTemplate: (folderPath: string) =>
      invoke(NotesChannels.invoke.GET_FOLDER_TEMPLATE, folderPath),

    // Export API (T106, T108)
    exportPdf: (input: { noteId: string; includeMetadata?: boolean; pageSize?: string }) =>
      invoke(
        NotesChannels.invoke.EXPORT_PDF,
        input as MainIpcInvokeArgs<typeof NotesChannels.invoke.EXPORT_PDF>[0]
      ),
    exportHtml: (input: { noteId: string; includeMetadata?: boolean }) =>
      invoke(NotesChannels.invoke.EXPORT_HTML, input),

    // Version History API (T114)
    getVersions: (noteId: string) => invoke(NotesChannels.invoke.GET_VERSIONS, noteId),
    getVersion: (snapshotId: string) => invoke(NotesChannels.invoke.GET_VERSION, snapshotId),
    restoreVersion: (snapshotId: string) =>
      invoke(NotesChannels.invoke.RESTORE_VERSION, snapshotId),
    deleteVersion: (snapshotId: string) => invoke(NotesChannels.invoke.DELETE_VERSION, snapshotId),

    // Position/Reorder API (drag-drop sidebar reordering)
    getPositions: (folderPath: string) =>
      invoke(NotesChannels.invoke.GET_POSITIONS, { folderPath }),
    getAllPositions: () => invoke(NotesChannels.invoke.GET_ALL_POSITIONS),
    reorder: (folderPath: string, notePaths: string[]) =>
      invoke(NotesChannels.invoke.REORDER, { folderPath, notePaths }),

    // File import API
    importFiles: (sourcePaths: string[], targetFolder?: string) =>
      invoke(NotesChannels.invoke.IMPORT_FILES, { sourcePaths, targetFolder }),
    showImportDialog: () => invoke(NotesChannels.invoke.SHOW_IMPORT_DIALOG),

    // Local-only API
    setLocalOnly: (id: string, localOnly: boolean) =>
      invoke(NotesChannels.invoke.SET_LOCAL_ONLY, { id, localOnly }),
    getLocalOnlyCount: () => invoke(NotesChannels.invoke.GET_LOCAL_ONLY_COUNT)
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

  // Search API
  search: {
    query: (input: {
      query: string
      types?: ('note' | 'task' | 'journal')[]
      tags?: string[]
      projectId?: string
      dateFrom?: string
      dateTo?: string
      includeArchived?: boolean
      includeCompleted?: boolean
      sortBy?: 'relevance' | 'modified' | 'created'
      limit?: number
      offset?: number
    }) => invoke(SearchChannels.invoke.SEARCH, input),
    quick: (input: { query: string; limit?: number }) =>
      invoke(SearchChannels.invoke.QUICK_SEARCH, input),
    suggestions: (input: { prefix: string; limit?: number }) =>
      invoke(SearchChannels.invoke.SUGGESTIONS, input),
    getRecent: () => invoke(SearchChannels.invoke.GET_RECENT),
    clearRecent: () => invoke(SearchChannels.invoke.CLEAR_RECENT),
    addRecent: (query: string) => invoke(SearchChannels.invoke.ADD_RECENT, query),
    getStats: () => invoke(SearchChannels.invoke.GET_STATS),
    rebuildIndex: () => invoke(SearchChannels.invoke.REBUILD_INDEX),
    searchNotes: (query: string, options?: { tags?: string[]; limit?: number }) =>
      invoke(SearchChannels.invoke.SEARCH_NOTES, { query, ...options }),
    findByTag: (tag: string) => invoke(SearchChannels.invoke.FIND_BY_TAG, tag),
    findBacklinks: (noteId: string) => invoke(SearchChannels.invoke.FIND_BACKLINKS, noteId),
    advancedSearch: (input: {
      text?: string
      operators?: {
        path?: string
        file?: string
        tags?: string[]
        properties?: { name: string; value: string }[]
      }
      titleOnly?: boolean
      sortBy?: 'relevance' | 'modified' | 'created' | 'title'
      sortDirection?: 'asc' | 'desc'
      folder?: string
      dateFrom?: string
      dateTo?: string
      limit?: number
      offset?: number
    }) => invoke(SearchChannels.invoke.ADVANCED_SEARCH, input)
  },

  // Tasks API
  tasks: {
    // Task CRUD
    create: (input: {
      projectId: string
      title: string
      description?: string | null
      priority?: number
      statusId?: string | null
      parentId?: string | null
      dueDate?: string | null
      dueTime?: string | null
      startDate?: string | null
      tags?: string[]
      linkedNoteIds?: string[]
      sourceNoteId?: string | null
      position?: number
    }) => invoke(TasksChannels.invoke.CREATE, input),
    get: (id: string) => invoke(TasksChannels.invoke.GET, id),
    update: (input: {
      id: string
      title?: string
      description?: string | null
      priority?: number
      projectId?: string
      statusId?: string | null
      parentId?: string | null
      dueDate?: string | null
      dueTime?: string | null
      startDate?: string | null
      tags?: string[]
      linkedNoteIds?: string[]
    }) => invoke(TasksChannels.invoke.UPDATE, input),
    delete: (id: string) => invoke(TasksChannels.invoke.DELETE, id),
    list: (options?: {
      projectId?: string
      statusId?: string | null
      parentId?: string | null
      includeCompleted?: boolean
      includeArchived?: boolean
      dueBefore?: string
      dueAfter?: string
      tags?: string[]
      search?: string
      sortBy?: 'position' | 'dueDate' | 'priority' | 'created' | 'modified'
      sortOrder?: 'asc' | 'desc'
      limit?: number
      offset?: number
    }) => invoke(TasksChannels.invoke.LIST, options ?? {}),

    // Task actions
    complete: (input: { id: string; completedAt?: string }) =>
      invoke(TasksChannels.invoke.COMPLETE, input),
    uncomplete: (id: string) => invoke(TasksChannels.invoke.UNCOMPLETE, id),
    archive: (id: string) => invoke(TasksChannels.invoke.ARCHIVE, id),
    unarchive: (id: string) => invoke(TasksChannels.invoke.UNARCHIVE, id),
    move: (input: {
      taskId: string
      targetProjectId?: string
      targetStatusId?: string | null
      targetParentId?: string | null
      position: number
    }) => invoke(TasksChannels.invoke.MOVE, input),
    reorder: (taskIds: string[], positions: number[]) =>
      invoke(TasksChannels.invoke.REORDER, { taskIds, positions }),
    duplicate: (id: string) => invoke(TasksChannels.invoke.DUPLICATE, id),

    // Subtask operations
    getSubtasks: (parentId: string) => invoke(TasksChannels.invoke.GET_SUBTASKS, parentId),
    convertToSubtask: (taskId: string, parentId: string) =>
      invoke(TasksChannels.invoke.CONVERT_TO_SUBTASK, { taskId, parentId }),
    convertToTask: (taskId: string) => invoke(TasksChannels.invoke.CONVERT_TO_TASK, taskId),

    // Project operations
    createProject: (input: {
      name: string
      description?: string | null
      color?: string
      icon?: string | null
      statuses?: Array<{
        name: string
        color: string
        type: string
        order: number
      }>
    }) =>
      invoke(
        TasksChannels.invoke.PROJECT_CREATE,
        input as MainIpcInvokeArgs<typeof TasksChannels.invoke.PROJECT_CREATE>[0]
      ),
    getProject: (id: string) => invoke(TasksChannels.invoke.PROJECT_GET, id),
    updateProject: (input: {
      id: string
      name?: string
      description?: string | null
      color?: string
      icon?: string | null
      statuses?: Array<{
        id?: string
        name: string
        color: string
        type: string
        order: number
      }>
    }) =>
      invoke(
        TasksChannels.invoke.PROJECT_UPDATE,
        input as MainIpcInvokeArgs<typeof TasksChannels.invoke.PROJECT_UPDATE>[0]
      ),
    deleteProject: (id: string) => invoke(TasksChannels.invoke.PROJECT_DELETE, id),
    listProjects: () => invoke(TasksChannels.invoke.PROJECT_LIST),
    archiveProject: (id: string) => invoke(TasksChannels.invoke.PROJECT_ARCHIVE, id),
    reorderProjects: (projectIds: string[], positions: number[]) =>
      invoke(TasksChannels.invoke.PROJECT_REORDER, { projectIds, positions }),

    // Status operations
    createStatus: (input: { projectId: string; name: string; color?: string; isDone?: boolean }) =>
      invoke(TasksChannels.invoke.STATUS_CREATE, input),
    updateStatus: (id: string, updates: Record<string, unknown>) =>
      invoke(TasksChannels.invoke.STATUS_UPDATE, { id, ...updates }),
    deleteStatus: (id: string) => invoke(TasksChannels.invoke.STATUS_DELETE, id),
    reorderStatuses: (statusIds: string[], positions: number[]) =>
      invoke(TasksChannels.invoke.STATUS_REORDER, { statusIds, positions }),
    listStatuses: (projectId: string) => invoke(TasksChannels.invoke.STATUS_LIST, projectId),

    // Tag operations
    getTags: () => invoke(TasksChannels.invoke.GET_TAGS),

    // Bulk operations
    bulkComplete: (ids: string[]) => invoke(TasksChannels.invoke.BULK_COMPLETE, { ids }),
    bulkDelete: (ids: string[]) => invoke(TasksChannels.invoke.BULK_DELETE, { ids }),
    bulkMove: (ids: string[], projectId: string) =>
      invoke(TasksChannels.invoke.BULK_MOVE, { ids, projectId }),
    bulkArchive: (ids: string[]) => invoke(TasksChannels.invoke.BULK_ARCHIVE, { ids }),

    // Stats and views
    getStats: () => invoke(TasksChannels.invoke.GET_STATS),
    getToday: () => invoke(TasksChannels.invoke.GET_TODAY),
    getUpcoming: (days?: number) => invoke(TasksChannels.invoke.GET_UPCOMING, { days: days ?? 7 }),
    getOverdue: () => invoke(TasksChannels.invoke.GET_OVERDUE),

    // Note linking
    getLinkedTasks: (noteId: string) => invoke(TasksChannels.invoke.GET_LINKED_TASKS, noteId),

    // Development/Testing
    seedPerformanceTest: () => invoke('tasks:seed-performance-test'),
    seedDemo: () => invoke('tasks:seed-demo')
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

  // Settings API
  settings: {
    get: (key: string) => invoke(SettingsChannels.invoke.GET, key),
    set: (key: string, value: string) => invoke(SettingsChannels.invoke.SET, { key, value }),
    getJournalSettings: () => invoke(SettingsChannels.invoke.GET_JOURNAL_SETTINGS),
    setJournalSettings: (settings: {
      defaultTemplate?: string | null
      showSchedule?: boolean
      showTasks?: boolean
      showAIConnections?: boolean
      showStatsFooter?: boolean
    }) => invoke(SettingsChannels.invoke.SET_JOURNAL_SETTINGS, settings),
    // AI Settings (simplified - no API key needed, uses local model)
    getAISettings: () => invoke(SettingsChannels.invoke.GET_AI_SETTINGS),
    setAISettings: (settings: { enabled?: boolean }) =>
      invoke(SettingsChannels.invoke.SET_AI_SETTINGS, settings),
    getAIModelStatus: () => invoke(SettingsChannels.invoke.GET_AI_MODEL_STATUS),
    loadAIModel: () => invoke(SettingsChannels.invoke.LOAD_AI_MODEL),
    reindexEmbeddings: () => invoke(SettingsChannels.invoke.REINDEX_EMBEDDINGS),
    // Tab Settings
    getTabSettings: () => invoke(SettingsChannels.invoke.GET_TAB_SETTINGS),
    setTabSettings: (settings: {
      previewMode?: boolean
      restoreSessionOnStart?: boolean
      tabCloseButton?: 'always' | 'hover' | 'active'
    }) => invoke(SettingsChannels.invoke.SET_TAB_SETTINGS, settings),
    // Note Editor Settings
    getNoteEditorSettings: () => invoke(SettingsChannels.invoke.GET_NOTE_EDITOR_SETTINGS),
    setNoteEditorSettings: (settings: { toolbarMode?: 'floating' | 'sticky' }) =>
      invoke(SettingsChannels.invoke.SET_NOTE_EDITOR_SETTINGS, settings)
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

  // Inbox API
  inbox: {
    // Capture
    captureText: (input: { content: string; title?: string; tags?: string[] }) =>
      invoke(InboxChannels.invoke.CAPTURE_TEXT, input),
    captureLink: (input: { url: string; tags?: string[] }) =>
      invoke(InboxChannels.invoke.CAPTURE_LINK, input),
    captureImage: (input: {
      data: ArrayBuffer
      filename: string
      mimeType: string
      tags?: string[]
    }) => invoke(InboxChannels.invoke.CAPTURE_IMAGE, input),
    captureVoice: (input: {
      data: ArrayBuffer
      duration: number
      format: string
      transcribe?: boolean
      tags?: string[]
    }) => invoke(InboxChannels.invoke.CAPTURE_VOICE, input),
    captureClip: (input: {
      html: string
      text: string
      sourceUrl: string
      sourceTitle: string
      tags?: string[]
    }) => invoke(InboxChannels.invoke.CAPTURE_CLIP, input),
    capturePdf: (input: {
      data: ArrayBuffer
      filename: string
      extractText?: boolean
      tags?: string[]
    }) => invoke(InboxChannels.invoke.CAPTURE_PDF, input),

    // CRUD
    get: (id: string) => invoke(InboxChannels.invoke.GET, id),
    list: (options?: {
      type?: string
      includeSnoozed?: boolean
      sortBy?: 'created' | 'modified' | 'title'
      sortOrder?: 'asc' | 'desc'
      limit?: number
      offset?: number
    }) => invoke(InboxChannels.invoke.LIST, options ?? {}),
    update: (input: { id: string; title?: string; content?: string }) =>
      invoke(InboxChannels.invoke.UPDATE, input),
    archive: (id: string) => invoke(InboxChannels.invoke.ARCHIVE, id),

    // Filing
    file: (input: {
      itemId: string
      destination: { type: string; path?: string; noteId?: string; noteTitle?: string }
      tags?: string[]
    }) => invoke(InboxChannels.invoke.FILE, input),
    getSuggestions: (itemId: string) => invoke(InboxChannels.invoke.GET_SUGGESTIONS, itemId),
    trackSuggestion: (input: {
      itemId: string
      itemType: string
      suggestedTo: string
      actualTo: string
      confidence: number
      suggestedTags?: string[]
      actualTags?: string[]
    }) =>
      invoke(
        InboxChannels.invoke.TRACK_SUGGESTION,
        input.itemId,
        input.itemType,
        input.suggestedTo,
        input.actualTo,
        input.confidence,
        input.suggestedTags || [],
        input.actualTags || []
      ),
    convertToNote: (itemId: string) => invoke(InboxChannels.invoke.CONVERT_TO_NOTE, itemId),
    linkToNote: (itemId: string, noteId: string, tags?: string[]) =>
      invoke(InboxChannels.invoke.LINK_TO_NOTE, itemId, noteId, tags || []),

    // Tags
    addTag: (itemId: string, tag: string) => invoke(InboxChannels.invoke.ADD_TAG, itemId, tag),
    removeTag: (itemId: string, tag: string) =>
      invoke(InboxChannels.invoke.REMOVE_TAG, itemId, tag),
    getTags: () => invoke(InboxChannels.invoke.GET_TAGS),

    // Snooze
    snooze: (input: { itemId: string; snoozeUntil: string; reason?: string }) =>
      invoke(InboxChannels.invoke.SNOOZE, input),
    unsnooze: (itemId: string) => invoke(InboxChannels.invoke.UNSNOOZE, itemId),
    getSnoozed: () => invoke(InboxChannels.invoke.GET_SNOOZED),
    bulkSnooze: (input: { itemIds: string[]; snoozeUntil: string; reason?: string }) =>
      invoke(InboxChannels.invoke.BULK_SNOOZE, input),

    // Viewed (for reminder items)
    markViewed: (itemId: string) => invoke(InboxChannels.invoke.MARK_VIEWED, itemId),

    // Bulk operations
    bulkFile: (input: {
      itemIds: string[]
      destination: { type: string; path?: string; noteId?: string }
      tags?: string[]
    }) => invoke(InboxChannels.invoke.BULK_FILE, input),
    bulkArchive: (input: { itemIds: string[] }) => invoke(InboxChannels.invoke.BULK_ARCHIVE, input),
    bulkTag: (input: { itemIds: string[]; tags: string[] }) =>
      invoke(InboxChannels.invoke.BULK_TAG, input),
    fileAllStale: () => invoke(InboxChannels.invoke.FILE_ALL_STALE),

    // Transcription
    retryTranscription: (itemId: string) =>
      invoke(InboxChannels.invoke.RETRY_TRANSCRIPTION, itemId),

    // Metadata
    retryMetadata: (itemId: string) => invoke(InboxChannels.invoke.RETRY_METADATA, itemId),

    // Stats
    getStats: () => invoke(InboxChannels.invoke.GET_STATS),
    getPatterns: () => invoke(InboxChannels.invoke.GET_PATTERNS),

    // Settings
    getStaleThreshold: () => invoke(InboxChannels.invoke.GET_STALE_THRESHOLD),
    setStaleThreshold: (days: number) => invoke(InboxChannels.invoke.SET_STALE_THRESHOLD, days),

    // Archived items
    listArchived: (options?: { search?: string; limit?: number; offset?: number }) =>
      invoke(InboxChannels.invoke.LIST_ARCHIVED, options ?? {}),
    unarchive: (id: string) => invoke(InboxChannels.invoke.UNARCHIVE, id),
    deletePermanent: (id: string) => invoke(InboxChannels.invoke.DELETE_PERMANENT, id),

    // Filing history
    getFilingHistory: (options?: { limit?: number }) =>
      invoke(InboxChannels.invoke.GET_FILING_HISTORY, options ?? {})
  },

  // Quick Capture API (global shortcut window)
  quickCapture: {
    /** Close the quick capture window */
    close: (): void => ipcRenderer.send('quick-capture:close'),
    /** Get current clipboard text content */
    getClipboard: (): Promise<string> => invoke('quick-capture:get-clipboard')
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
      invoke(TagsChannels.invoke.REMOVE_TAG_FROM_NOTE, input)
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

  // Notes event subscription helpers
  onNoteCreated: (callback: (event: unknown) => void): (() => void) => {
    const handler = (_event: Electron.IpcRendererEvent, data: unknown): void => callback(data)
    ipcRenderer.on(NotesChannels.events.CREATED, handler)
    return () => ipcRenderer.removeListener(NotesChannels.events.CREATED, handler)
  },

  onNoteUpdated: (callback: (event: unknown) => void): (() => void) => {
    const handler = (_event: Electron.IpcRendererEvent, data: unknown): void => callback(data)
    ipcRenderer.on(NotesChannels.events.UPDATED, handler)
    return () => ipcRenderer.removeListener(NotesChannels.events.UPDATED, handler)
  },

  onNoteDeleted: (callback: (event: unknown) => void): (() => void) => {
    const handler = (_event: Electron.IpcRendererEvent, data: unknown): void => callback(data)
    ipcRenderer.on(NotesChannels.events.DELETED, handler)
    return () => ipcRenderer.removeListener(NotesChannels.events.DELETED, handler)
  },

  onNoteRenamed: (callback: (event: unknown) => void): (() => void) => {
    const handler = (_event: Electron.IpcRendererEvent, data: unknown): void => callback(data)
    ipcRenderer.on(NotesChannels.events.RENAMED, handler)
    return () => ipcRenderer.removeListener(NotesChannels.events.RENAMED, handler)
  },

  onNoteMoved: (callback: (event: unknown) => void): (() => void) => {
    const handler = (_event: Electron.IpcRendererEvent, data: unknown): void => callback(data)
    ipcRenderer.on(NotesChannels.events.MOVED, handler)
    return () => ipcRenderer.removeListener(NotesChannels.events.MOVED, handler)
  },

  onNoteExternalChange: (callback: (event: unknown) => void): (() => void) => {
    const handler = (_event: Electron.IpcRendererEvent, data: unknown): void => callback(data)
    ipcRenderer.on(NotesChannels.events.EXTERNAL_CHANGE, handler)
    return () => ipcRenderer.removeListener(NotesChannels.events.EXTERNAL_CHANGE, handler)
  },

  // Tags changed event (for cross-note tag autocomplete refresh)
  onTagsChanged: (callback: () => void): (() => void) => {
    const handler = (): void => callback()
    ipcRenderer.on('notes:tags-changed', handler)
    return () => ipcRenderer.removeListener('notes:tags-changed', handler)
  },

  // Search event subscription helpers
  onSearchIndexRebuildStarted: (callback: () => void): (() => void) => {
    const handler = (): void => callback()
    ipcRenderer.on(SearchChannels.events.INDEX_REBUILD_STARTED, handler)
    return () => ipcRenderer.removeListener(SearchChannels.events.INDEX_REBUILD_STARTED, handler)
  },

  onSearchIndexRebuildProgress: (
    callback: (progress: {
      phase: string
      current: number
      total: number
      percentage: number
    }) => void
  ): (() => void) => {
    const handler = (
      _event: Electron.IpcRendererEvent,
      progress: { phase: string; current: number; total: number; percentage: number }
    ): void => callback(progress)
    ipcRenderer.on(SearchChannels.events.INDEX_REBUILD_PROGRESS, handler)
    return () => ipcRenderer.removeListener(SearchChannels.events.INDEX_REBUILD_PROGRESS, handler)
  },

  onSearchIndexRebuildCompleted: (
    callback: (result: { duration: number; notesIndexed: number; tasksIndexed: number }) => void
  ): (() => void) => {
    const handler = (
      _event: Electron.IpcRendererEvent,
      result: { duration: number; notesIndexed: number; tasksIndexed: number }
    ): void => callback(result)
    ipcRenderer.on(SearchChannels.events.INDEX_REBUILD_COMPLETED, handler)
    return () => ipcRenderer.removeListener(SearchChannels.events.INDEX_REBUILD_COMPLETED, handler)
  },

  onSearchIndexCorrupt: (callback: () => void): (() => void) => {
    const handler = (): void => callback()
    ipcRenderer.on(SearchChannels.events.INDEX_CORRUPT, handler)
    return () => ipcRenderer.removeListener(SearchChannels.events.INDEX_CORRUPT, handler)
  },

  // Tasks event subscription helpers
  onTaskCreated: (callback: (event: { task: unknown }) => void): (() => void) => {
    const handler = (_event: Electron.IpcRendererEvent, data: { task: unknown }): void =>
      callback(data)
    ipcRenderer.on(TasksChannels.events.CREATED, handler)
    return () => ipcRenderer.removeListener(TasksChannels.events.CREATED, handler)
  },

  onTaskUpdated: (
    callback: (event: { id: string; task: unknown; changes: unknown }) => void
  ): (() => void) => {
    const handler = (
      _event: Electron.IpcRendererEvent,
      data: { id: string; task: unknown; changes: unknown }
    ): void => callback(data)
    ipcRenderer.on(TasksChannels.events.UPDATED, handler)
    return () => ipcRenderer.removeListener(TasksChannels.events.UPDATED, handler)
  },

  onTaskDeleted: (callback: (event: { id: string }) => void): (() => void) => {
    const handler = (_event: Electron.IpcRendererEvent, data: { id: string }): void =>
      callback(data)
    ipcRenderer.on(TasksChannels.events.DELETED, handler)
    return () => ipcRenderer.removeListener(TasksChannels.events.DELETED, handler)
  },

  onTaskCompleted: (callback: (event: { id: string; task: unknown }) => void): (() => void) => {
    const handler = (
      _event: Electron.IpcRendererEvent,
      data: { id: string; task: unknown }
    ): void => callback(data)
    ipcRenderer.on(TasksChannels.events.COMPLETED, handler)
    return () => ipcRenderer.removeListener(TasksChannels.events.COMPLETED, handler)
  },

  onTaskMoved: (callback: (event: { id: string; task: unknown }) => void): (() => void) => {
    const handler = (
      _event: Electron.IpcRendererEvent,
      data: { id: string; task: unknown }
    ): void => callback(data)
    ipcRenderer.on(TasksChannels.events.MOVED, handler)
    return () => ipcRenderer.removeListener(TasksChannels.events.MOVED, handler)
  },

  onProjectCreated: (callback: (event: { project: unknown }) => void): (() => void) => {
    const handler = (_event: Electron.IpcRendererEvent, data: { project: unknown }): void =>
      callback(data)
    ipcRenderer.on(TasksChannels.events.PROJECT_CREATED, handler)
    return () => ipcRenderer.removeListener(TasksChannels.events.PROJECT_CREATED, handler)
  },

  onProjectUpdated: (callback: (event: { id: string; project: unknown }) => void): (() => void) => {
    const handler = (
      _event: Electron.IpcRendererEvent,
      data: { id: string; project: unknown }
    ): void => callback(data)
    ipcRenderer.on(TasksChannels.events.PROJECT_UPDATED, handler)
    return () => ipcRenderer.removeListener(TasksChannels.events.PROJECT_UPDATED, handler)
  },

  onProjectDeleted: (callback: (event: { id: string }) => void): (() => void) => {
    const handler = (_event: Electron.IpcRendererEvent, data: { id: string }): void =>
      callback(data)
    ipcRenderer.on(TasksChannels.events.PROJECT_DELETED, handler)
    return () => ipcRenderer.removeListener(TasksChannels.events.PROJECT_DELETED, handler)
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

  // Settings event subscription helpers
  onSettingsChanged: (callback: (event: { key: string; value: unknown }) => void): (() => void) => {
    const handler = (
      _event: Electron.IpcRendererEvent,
      data: { key: string; value: unknown }
    ): void => callback(data)
    ipcRenderer.on(SettingsChannels.events.CHANGED, handler)
    return () => ipcRenderer.removeListener(SettingsChannels.events.CHANGED, handler)
  },

  onEmbeddingProgress: (
    callback: (event: { current: number; total: number; phase: string }) => void
  ): (() => void) => {
    const handler = (
      _event: Electron.IpcRendererEvent,
      data: { current: number; total: number; phase: string }
    ): void => callback(data)
    ipcRenderer.on(SettingsChannels.events.EMBEDDING_PROGRESS, handler)
    return () => ipcRenderer.removeListener(SettingsChannels.events.EMBEDDING_PROGRESS, handler)
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

  // Inbox event subscription helpers
  onInboxCaptured: (callback: (event: { item: unknown }) => void): (() => void) => {
    const handler = (_event: Electron.IpcRendererEvent, data: { item: unknown }): void =>
      callback(data)
    ipcRenderer.on(InboxChannels.events.CAPTURED, handler)
    return () => ipcRenderer.removeListener(InboxChannels.events.CAPTURED, handler)
  },

  onInboxUpdated: (callback: (event: { id: string; changes: unknown }) => void): (() => void) => {
    const handler = (
      _event: Electron.IpcRendererEvent,
      data: { id: string; changes: unknown }
    ): void => callback(data)
    ipcRenderer.on(InboxChannels.events.UPDATED, handler)
    return () => ipcRenderer.removeListener(InboxChannels.events.UPDATED, handler)
  },

  onInboxArchived: (callback: (event: { id: string }) => void): (() => void) => {
    const handler = (_event: Electron.IpcRendererEvent, data: { id: string }): void =>
      callback(data)
    ipcRenderer.on(InboxChannels.events.ARCHIVED, handler)
    return () => ipcRenderer.removeListener(InboxChannels.events.ARCHIVED, handler)
  },

  onInboxFiled: (
    callback: (event: { id: string; filedTo: string; filedAction: string }) => void
  ): (() => void) => {
    const handler = (
      _event: Electron.IpcRendererEvent,
      data: { id: string; filedTo: string; filedAction: string }
    ): void => callback(data)
    ipcRenderer.on(InboxChannels.events.FILED, handler)
    return () => ipcRenderer.removeListener(InboxChannels.events.FILED, handler)
  },

  onInboxSnoozed: (
    callback: (event: { id: string; snoozeUntil: string }) => void
  ): (() => void) => {
    const handler = (
      _event: Electron.IpcRendererEvent,
      data: { id: string; snoozeUntil: string }
    ): void => callback(data)
    ipcRenderer.on(InboxChannels.events.SNOOZED, handler)
    return () => ipcRenderer.removeListener(InboxChannels.events.SNOOZED, handler)
  },

  onInboxSnoozeDue: (callback: (event: { items: unknown[] }) => void): (() => void) => {
    const handler = (_event: Electron.IpcRendererEvent, data: { items: unknown[] }): void =>
      callback(data)
    ipcRenderer.on(InboxChannels.events.SNOOZE_DUE, handler)
    return () => ipcRenderer.removeListener(InboxChannels.events.SNOOZE_DUE, handler)
  },

  onInboxTranscriptionComplete: (
    callback: (event: { id: string; transcription: string }) => void
  ): (() => void) => {
    const handler = (
      _event: Electron.IpcRendererEvent,
      data: { id: string; transcription: string }
    ): void => callback(data)
    ipcRenderer.on(InboxChannels.events.TRANSCRIPTION_COMPLETE, handler)
    return () => ipcRenderer.removeListener(InboxChannels.events.TRANSCRIPTION_COMPLETE, handler)
  },

  onInboxMetadataComplete: (
    callback: (event: { id: string; metadata: unknown }) => void
  ): (() => void) => {
    const handler = (
      _event: Electron.IpcRendererEvent,
      data: { id: string; metadata: unknown }
    ): void => callback(data)
    ipcRenderer.on(InboxChannels.events.METADATA_COMPLETE, handler)
    return () => ipcRenderer.removeListener(InboxChannels.events.METADATA_COMPLETE, handler)
  },

  onInboxProcessingError: (
    callback: (event: { id: string; operation: string; error: string }) => void
  ): (() => void) => {
    const handler = (
      _event: Electron.IpcRendererEvent,
      data: { id: string; operation: string; error: string }
    ): void => callback(data)
    ipcRenderer.on(InboxChannels.events.PROCESSING_ERROR, handler)
    return () => ipcRenderer.removeListener(InboxChannels.events.PROCESSING_ERROR, handler)
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
