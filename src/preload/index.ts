import { contextBridge, ipcRenderer } from 'electron'
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
  FolderViewChannels
} from '@shared/ipc-channels'

// Custom APIs for renderer
const api = {
  // Window controls for custom traffic lights
  windowMinimize: (): void => ipcRenderer.send('window-minimize'),
  windowMaximize: (): void => ipcRenderer.send('window-maximize'),
  windowClose: (): void => ipcRenderer.send('window-close'),

  // Vault API
  vault: {
    select: (path?: string) => ipcRenderer.invoke(VaultChannels.invoke.SELECT, { path }),
    create: (path: string, name: string) =>
      ipcRenderer.invoke(VaultChannels.invoke.CREATE, { path, name }),
    getAll: () => ipcRenderer.invoke(VaultChannels.invoke.GET_ALL),
    getStatus: () => ipcRenderer.invoke(VaultChannels.invoke.GET_STATUS),
    getConfig: () => ipcRenderer.invoke(VaultChannels.invoke.GET_CONFIG),
    updateConfig: (config: Record<string, unknown>) =>
      ipcRenderer.invoke(VaultChannels.invoke.UPDATE_CONFIG, config),
    close: () => ipcRenderer.invoke(VaultChannels.invoke.CLOSE),
    switch: (vaultPath: string) => ipcRenderer.invoke(VaultChannels.invoke.SWITCH, vaultPath),
    remove: (vaultPath: string) => ipcRenderer.invoke(VaultChannels.invoke.REMOVE, vaultPath),
    reindex: () => ipcRenderer.invoke(VaultChannels.invoke.REINDEX)
  },

  // Notes API
  notes: {
    create: (input: { title: string; content?: string; folder?: string; tags?: string[] }) =>
      ipcRenderer.invoke(NotesChannels.invoke.CREATE, input),
    get: (id: string) => ipcRenderer.invoke(NotesChannels.invoke.GET, id),
    getByPath: (path: string) => ipcRenderer.invoke(NotesChannels.invoke.GET_BY_PATH, path),
    update: (input: {
      id: string
      title?: string
      content?: string
      tags?: string[]
      frontmatter?: Record<string, unknown>
      emoji?: string | null // T028: Emoji support
    }) => ipcRenderer.invoke(NotesChannels.invoke.UPDATE, input),
    rename: (id: string, newTitle: string) =>
      ipcRenderer.invoke(NotesChannels.invoke.RENAME, { id, newTitle }),
    move: (id: string, newFolder: string) =>
      ipcRenderer.invoke(NotesChannels.invoke.MOVE, { id, newFolder }),
    delete: (id: string) => ipcRenderer.invoke(NotesChannels.invoke.DELETE, id),
    list: (options?: {
      folder?: string
      tags?: string[]
      sortBy?: 'modified' | 'created' | 'title'
      sortOrder?: 'asc' | 'desc'
      limit?: number
      offset?: number
    }) => ipcRenderer.invoke(NotesChannels.invoke.LIST, options ?? {}),
    getTags: () => ipcRenderer.invoke(NotesChannels.invoke.GET_TAGS),
    getLinks: (id: string) => ipcRenderer.invoke(NotesChannels.invoke.GET_LINKS, id),
    getFolders: () => ipcRenderer.invoke(NotesChannels.invoke.GET_FOLDERS),
    createFolder: (path: string) => ipcRenderer.invoke(NotesChannels.invoke.CREATE_FOLDER, path),
    renameFolder: (oldPath: string, newPath: string) =>
      ipcRenderer.invoke(NotesChannels.invoke.RENAME_FOLDER, { oldPath, newPath }),
    deleteFolder: (path: string) => ipcRenderer.invoke(NotesChannels.invoke.DELETE_FOLDER, path),
    exists: (titleOrPath: string) => ipcRenderer.invoke(NotesChannels.invoke.EXISTS, titleOrPath),
    openExternal: (id: string) => ipcRenderer.invoke(NotesChannels.invoke.OPEN_EXTERNAL, id),
    revealInFinder: (id: string) => ipcRenderer.invoke(NotesChannels.invoke.REVEAL_IN_FINDER, id),

    // T019: Properties API
    getProperties: (noteId: string) =>
      ipcRenderer.invoke(NotesChannels.invoke.GET_PROPERTIES, noteId),
    setProperties: (noteId: string, properties: Record<string, unknown>) =>
      ipcRenderer.invoke(NotesChannels.invoke.SET_PROPERTIES, { noteId, properties }),
    getPropertyDefinitions: () => ipcRenderer.invoke(NotesChannels.invoke.GET_PROPERTY_DEFINITIONS),
    createPropertyDefinition: (input: {
      name: string
      type: string
      options?: string[]
      defaultValue?: unknown
      color?: string
    }) => ipcRenderer.invoke(NotesChannels.invoke.CREATE_PROPERTY_DEFINITION, input),
    updatePropertyDefinition: (input: {
      name: string
      type?: string
      options?: string[]
      defaultValue?: unknown
      color?: string
    }) => ipcRenderer.invoke(NotesChannels.invoke.UPDATE_PROPERTY_DEFINITION, input),

    // T070: Attachments API
    uploadAttachment: (noteId: string, file: File) => {
      return new Promise((resolve, reject) => {
        const reader = new FileReader()
        reader.onload = () => {
          const arrayBuffer = reader.result as ArrayBuffer
          ipcRenderer
            .invoke(NotesChannels.invoke.UPLOAD_ATTACHMENT, {
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
    listAttachments: (noteId: string) =>
      ipcRenderer.invoke(NotesChannels.invoke.LIST_ATTACHMENTS, noteId),
    deleteAttachment: (noteId: string, filename: string) =>
      ipcRenderer.invoke(NotesChannels.invoke.DELETE_ATTACHMENT, { noteId, filename }),

    // Folder config API (T096.5)
    getFolderConfig: (folderPath: string) =>
      ipcRenderer.invoke(NotesChannels.invoke.GET_FOLDER_CONFIG, folderPath),
    setFolderConfig: (folderPath: string, config: { template?: string; inherit?: boolean }) =>
      ipcRenderer.invoke(NotesChannels.invoke.SET_FOLDER_CONFIG, { folderPath, config }),
    getFolderTemplate: (folderPath: string) =>
      ipcRenderer.invoke(NotesChannels.invoke.GET_FOLDER_TEMPLATE, folderPath),

    // Export API (T106, T108)
    exportPdf: (input: { noteId: string; includeMetadata?: boolean; pageSize?: string }) =>
      ipcRenderer.invoke(NotesChannels.invoke.EXPORT_PDF, input),
    exportHtml: (input: { noteId: string; includeMetadata?: boolean }) =>
      ipcRenderer.invoke(NotesChannels.invoke.EXPORT_HTML, input),

    // Version History API (T114)
    getVersions: (noteId: string) => ipcRenderer.invoke(NotesChannels.invoke.GET_VERSIONS, noteId),
    getVersion: (snapshotId: string) =>
      ipcRenderer.invoke(NotesChannels.invoke.GET_VERSION, snapshotId),
    restoreVersion: (snapshotId: string) =>
      ipcRenderer.invoke(NotesChannels.invoke.RESTORE_VERSION, snapshotId),
    deleteVersion: (snapshotId: string) =>
      ipcRenderer.invoke(NotesChannels.invoke.DELETE_VERSION, snapshotId)
  },

  // Templates API
  templates: {
    list: () => ipcRenderer.invoke(TemplatesChannels.invoke.LIST),
    get: (id: string) => ipcRenderer.invoke(TemplatesChannels.invoke.GET, id),
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
    }) => ipcRenderer.invoke(TemplatesChannels.invoke.CREATE, input),
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
    }) => ipcRenderer.invoke(TemplatesChannels.invoke.UPDATE, input),
    delete: (id: string) => ipcRenderer.invoke(TemplatesChannels.invoke.DELETE, id),
    duplicate: (id: string, newName: string) =>
      ipcRenderer.invoke(TemplatesChannels.invoke.DUPLICATE, { id, newName })
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
    }) => ipcRenderer.invoke(SearchChannels.invoke.SEARCH, input),
    quick: (input: { query: string; limit?: number }) =>
      ipcRenderer.invoke(SearchChannels.invoke.QUICK_SEARCH, input),
    suggestions: (input: { prefix: string; limit?: number }) =>
      ipcRenderer.invoke(SearchChannels.invoke.SUGGESTIONS, input),
    getRecent: () => ipcRenderer.invoke(SearchChannels.invoke.GET_RECENT),
    clearRecent: () => ipcRenderer.invoke(SearchChannels.invoke.CLEAR_RECENT),
    addRecent: (query: string) => ipcRenderer.invoke(SearchChannels.invoke.ADD_RECENT, query),
    getStats: () => ipcRenderer.invoke(SearchChannels.invoke.GET_STATS),
    rebuildIndex: () => ipcRenderer.invoke(SearchChannels.invoke.REBUILD_INDEX),
    searchNotes: (query: string, options?: { tags?: string[]; limit?: number }) =>
      ipcRenderer.invoke(SearchChannels.invoke.SEARCH_NOTES, { query, ...options }),
    findByTag: (tag: string) => ipcRenderer.invoke(SearchChannels.invoke.FIND_BY_TAG, tag),
    findBacklinks: (noteId: string) =>
      ipcRenderer.invoke(SearchChannels.invoke.FIND_BACKLINKS, noteId)
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
    }) => ipcRenderer.invoke(TasksChannels.invoke.CREATE, input),
    get: (id: string) => ipcRenderer.invoke(TasksChannels.invoke.GET, id),
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
    }) => ipcRenderer.invoke(TasksChannels.invoke.UPDATE, input),
    delete: (id: string) => ipcRenderer.invoke(TasksChannels.invoke.DELETE, id),
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
    }) => ipcRenderer.invoke(TasksChannels.invoke.LIST, options ?? {}),

    // Task actions
    complete: (input: { id: string; completedAt?: string }) =>
      ipcRenderer.invoke(TasksChannels.invoke.COMPLETE, input),
    uncomplete: (id: string) => ipcRenderer.invoke(TasksChannels.invoke.UNCOMPLETE, id),
    archive: (id: string) => ipcRenderer.invoke(TasksChannels.invoke.ARCHIVE, id),
    unarchive: (id: string) => ipcRenderer.invoke(TasksChannels.invoke.UNARCHIVE, id),
    move: (input: {
      taskId: string
      targetProjectId?: string
      targetStatusId?: string | null
      targetParentId?: string | null
      position: number
    }) => ipcRenderer.invoke(TasksChannels.invoke.MOVE, input),
    reorder: (taskIds: string[], positions: number[]) =>
      ipcRenderer.invoke(TasksChannels.invoke.REORDER, { taskIds, positions }),
    duplicate: (id: string) => ipcRenderer.invoke(TasksChannels.invoke.DUPLICATE, id),

    // Subtask operations
    getSubtasks: (parentId: string) =>
      ipcRenderer.invoke(TasksChannels.invoke.GET_SUBTASKS, parentId),
    convertToSubtask: (taskId: string, parentId: string) =>
      ipcRenderer.invoke(TasksChannels.invoke.CONVERT_TO_SUBTASK, { taskId, parentId }),
    convertToTask: (taskId: string) =>
      ipcRenderer.invoke(TasksChannels.invoke.CONVERT_TO_TASK, taskId),

    // Project operations
    createProject: (input: {
      name: string
      description?: string | null
      color?: string
      icon?: string | null
    }) => ipcRenderer.invoke(TasksChannels.invoke.PROJECT_CREATE, input),
    getProject: (id: string) => ipcRenderer.invoke(TasksChannels.invoke.PROJECT_GET, id),
    updateProject: (input: {
      id: string
      name?: string
      description?: string | null
      color?: string
      icon?: string | null
    }) => ipcRenderer.invoke(TasksChannels.invoke.PROJECT_UPDATE, input),
    deleteProject: (id: string) => ipcRenderer.invoke(TasksChannels.invoke.PROJECT_DELETE, id),
    listProjects: () => ipcRenderer.invoke(TasksChannels.invoke.PROJECT_LIST),
    archiveProject: (id: string) => ipcRenderer.invoke(TasksChannels.invoke.PROJECT_ARCHIVE, id),
    reorderProjects: (projectIds: string[], positions: number[]) =>
      ipcRenderer.invoke(TasksChannels.invoke.PROJECT_REORDER, { projectIds, positions }),

    // Status operations
    createStatus: (input: { projectId: string; name: string; color?: string; isDone?: boolean }) =>
      ipcRenderer.invoke(TasksChannels.invoke.STATUS_CREATE, input),
    updateStatus: (id: string, updates: Record<string, unknown>) =>
      ipcRenderer.invoke(TasksChannels.invoke.STATUS_UPDATE, { id, ...updates }),
    deleteStatus: (id: string) => ipcRenderer.invoke(TasksChannels.invoke.STATUS_DELETE, id),
    reorderStatuses: (statusIds: string[], positions: number[]) =>
      ipcRenderer.invoke(TasksChannels.invoke.STATUS_REORDER, { statusIds, positions }),
    listStatuses: (projectId: string) =>
      ipcRenderer.invoke(TasksChannels.invoke.STATUS_LIST, projectId),

    // Tag operations
    getTags: () => ipcRenderer.invoke(TasksChannels.invoke.GET_TAGS),

    // Bulk operations
    bulkComplete: (ids: string[]) =>
      ipcRenderer.invoke(TasksChannels.invoke.BULK_COMPLETE, { ids }),
    bulkDelete: (ids: string[]) => ipcRenderer.invoke(TasksChannels.invoke.BULK_DELETE, { ids }),
    bulkMove: (ids: string[], projectId: string) =>
      ipcRenderer.invoke(TasksChannels.invoke.BULK_MOVE, { ids, projectId }),
    bulkArchive: (ids: string[]) => ipcRenderer.invoke(TasksChannels.invoke.BULK_ARCHIVE, { ids }),

    // Stats and views
    getStats: () => ipcRenderer.invoke(TasksChannels.invoke.GET_STATS),
    getToday: () => ipcRenderer.invoke(TasksChannels.invoke.GET_TODAY),
    getUpcoming: (days?: number) =>
      ipcRenderer.invoke(TasksChannels.invoke.GET_UPCOMING, { days: days ?? 7 }),
    getOverdue: () => ipcRenderer.invoke(TasksChannels.invoke.GET_OVERDUE),

    // Note linking
    getLinkedTasks: (noteId: string) =>
      ipcRenderer.invoke(TasksChannels.invoke.GET_LINKED_TASKS, noteId),

    // Development/Testing
    seedPerformanceTest: () => ipcRenderer.invoke('tasks:seed-performance-test'),
    seedDemo: () => ipcRenderer.invoke('tasks:seed-demo')
  },

  // Saved Filters API
  savedFilters: {
    list: () => ipcRenderer.invoke(SavedFiltersChannels.invoke.LIST),
    create: (input: { name: string; config: unknown }) =>
      ipcRenderer.invoke(SavedFiltersChannels.invoke.CREATE, input),
    update: (input: { id: string; name?: string; config?: unknown; position?: number }) =>
      ipcRenderer.invoke(SavedFiltersChannels.invoke.UPDATE, input),
    delete: (id: string) => ipcRenderer.invoke(SavedFiltersChannels.invoke.DELETE, { id }),
    reorder: (ids: string[], positions: number[]) =>
      ipcRenderer.invoke(SavedFiltersChannels.invoke.REORDER, { ids, positions })
  },

  // Journal API
  journal: {
    // Entry CRUD
    getEntry: (date: string) => ipcRenderer.invoke(JournalChannels.invoke.GET_ENTRY, { date }),
    createEntry: (input: { date: string; content?: string; tags?: string[] }) =>
      ipcRenderer.invoke(JournalChannels.invoke.CREATE_ENTRY, input),
    updateEntry: (input: { date: string; content?: string; tags?: string[] }) =>
      ipcRenderer.invoke(JournalChannels.invoke.UPDATE_ENTRY, input),
    deleteEntry: (date: string) =>
      ipcRenderer.invoke(JournalChannels.invoke.DELETE_ENTRY, { date }),

    // Calendar & Views
    getHeatmap: (year: number) => ipcRenderer.invoke(JournalChannels.invoke.GET_HEATMAP, { year }),
    getMonthEntries: (year: number, month: number) =>
      ipcRenderer.invoke(JournalChannels.invoke.GET_MONTH_ENTRIES, { year, month }),
    getYearStats: (year: number) =>
      ipcRenderer.invoke(JournalChannels.invoke.GET_YEAR_STATS, { year }),

    // Context
    getDayContext: (date: string) =>
      ipcRenderer.invoke(JournalChannels.invoke.GET_DAY_CONTEXT, { date }),

    // Tags
    getAllTags: () => ipcRenderer.invoke(JournalChannels.invoke.GET_ALL_TAGS),

    // Streak
    getStreak: () => ipcRenderer.invoke(JournalChannels.invoke.GET_STREAK)
  },

  // Settings API
  settings: {
    get: (key: string) => ipcRenderer.invoke(SettingsChannels.invoke.GET, key),
    set: (key: string, value: string) =>
      ipcRenderer.invoke(SettingsChannels.invoke.SET, { key, value }),
    getJournalSettings: () => ipcRenderer.invoke(SettingsChannels.invoke.GET_JOURNAL_SETTINGS),
    setJournalSettings: (settings: { defaultTemplate?: string | null }) =>
      ipcRenderer.invoke(SettingsChannels.invoke.SET_JOURNAL_SETTINGS, settings),
    // AI Settings (simplified - no API key needed, uses local model)
    getAISettings: () => ipcRenderer.invoke(SettingsChannels.invoke.GET_AI_SETTINGS),
    setAISettings: (settings: { enabled?: boolean }) =>
      ipcRenderer.invoke(SettingsChannels.invoke.SET_AI_SETTINGS, settings),
    getAIModelStatus: () => ipcRenderer.invoke(SettingsChannels.invoke.GET_AI_MODEL_STATUS),
    loadAIModel: () => ipcRenderer.invoke(SettingsChannels.invoke.LOAD_AI_MODEL),
    reindexEmbeddings: () => ipcRenderer.invoke(SettingsChannels.invoke.REINDEX_EMBEDDINGS),
    // Tab Settings
    getTabSettings: () => ipcRenderer.invoke(SettingsChannels.invoke.GET_TAB_SETTINGS),
    setTabSettings: (settings: {
      previewMode?: boolean
      restoreSessionOnStart?: boolean
      tabCloseButton?: 'always' | 'hover' | 'active'
    }) => ipcRenderer.invoke(SettingsChannels.invoke.SET_TAB_SETTINGS, settings)
  },

  // Bookmarks API
  bookmarks: {
    /** Create a new bookmark */
    create: (input: { itemType: string; itemId: string }) =>
      ipcRenderer.invoke(BookmarksChannels.invoke.CREATE, input),
    /** Delete a bookmark by ID */
    delete: (id: string) => ipcRenderer.invoke(BookmarksChannels.invoke.DELETE, id),
    /** Get a bookmark by ID */
    get: (id: string) => ipcRenderer.invoke(BookmarksChannels.invoke.GET, id),
    /** List bookmarks with optional filters */
    list: (options?: {
      itemType?: string
      sortBy?: 'position' | 'createdAt'
      sortOrder?: 'asc' | 'desc'
      limit?: number
      offset?: number
    }) => ipcRenderer.invoke(BookmarksChannels.invoke.LIST, options ?? {}),
    /** Check if an item is bookmarked */
    isBookmarked: (input: { itemType: string; itemId: string }) =>
      ipcRenderer.invoke(BookmarksChannels.invoke.IS_BOOKMARKED, input),
    /** Toggle bookmark status (create or delete) */
    toggle: (input: { itemType: string; itemId: string }) =>
      ipcRenderer.invoke(BookmarksChannels.invoke.TOGGLE, input),
    /** Reorder bookmarks */
    reorder: (bookmarkIds: string[]) =>
      ipcRenderer.invoke(BookmarksChannels.invoke.REORDER, { bookmarkIds }),
    /** List bookmarks by item type */
    listByType: (itemType: string) =>
      ipcRenderer.invoke(BookmarksChannels.invoke.LIST_BY_TYPE, itemType),
    /** Get bookmark for a specific item */
    getByItem: (input: { itemType: string; itemId: string }) =>
      ipcRenderer.invoke(BookmarksChannels.invoke.GET_BY_ITEM, input),
    /** Delete multiple bookmarks */
    bulkDelete: (bookmarkIds: string[]) =>
      ipcRenderer.invoke(BookmarksChannels.invoke.BULK_DELETE, { bookmarkIds }),
    /** Create multiple bookmarks */
    bulkCreate: (items: Array<{ itemType: string; itemId: string }>) =>
      ipcRenderer.invoke(BookmarksChannels.invoke.BULK_CREATE, { items })
  },

  // Inbox API
  inbox: {
    // Capture
    captureText: (input: { content: string; title?: string; tags?: string[] }) =>
      ipcRenderer.invoke(InboxChannels.invoke.CAPTURE_TEXT, input),
    captureLink: (input: { url: string; tags?: string[] }) =>
      ipcRenderer.invoke(InboxChannels.invoke.CAPTURE_LINK, input),
    captureImage: (input: {
      data: ArrayBuffer
      filename: string
      mimeType: string
      tags?: string[]
    }) => ipcRenderer.invoke(InboxChannels.invoke.CAPTURE_IMAGE, input),
    captureVoice: (input: {
      data: ArrayBuffer
      duration: number
      format: string
      transcribe?: boolean
      tags?: string[]
    }) => ipcRenderer.invoke(InboxChannels.invoke.CAPTURE_VOICE, input),
    captureClip: (input: {
      html: string
      text: string
      sourceUrl: string
      sourceTitle: string
      tags?: string[]
    }) => ipcRenderer.invoke(InboxChannels.invoke.CAPTURE_CLIP, input),
    capturePdf: (input: {
      data: ArrayBuffer
      filename: string
      extractText?: boolean
      tags?: string[]
    }) => ipcRenderer.invoke(InboxChannels.invoke.CAPTURE_PDF, input),

    // CRUD
    get: (id: string) => ipcRenderer.invoke(InboxChannels.invoke.GET, id),
    list: (options?: {
      type?: string
      includeSnoozed?: boolean
      sortBy?: 'created' | 'modified' | 'title'
      sortOrder?: 'asc' | 'desc'
      limit?: number
      offset?: number
    }) => ipcRenderer.invoke(InboxChannels.invoke.LIST, options ?? {}),
    update: (input: { id: string; title?: string; content?: string }) =>
      ipcRenderer.invoke(InboxChannels.invoke.UPDATE, input),
    archive: (id: string) => ipcRenderer.invoke(InboxChannels.invoke.ARCHIVE, id),

    // Filing
    file: (input: {
      itemId: string
      destination: { type: string; path?: string; noteId?: string; noteTitle?: string }
      tags?: string[]
    }) => ipcRenderer.invoke(InboxChannels.invoke.FILE, input),
    getSuggestions: (itemId: string) =>
      ipcRenderer.invoke(InboxChannels.invoke.GET_SUGGESTIONS, itemId),
    trackSuggestion: (input: {
      itemId: string
      itemType: string
      suggestedTo: string
      actualTo: string
      confidence: number
      suggestedTags?: string[]
      actualTags?: string[]
    }) =>
      ipcRenderer.invoke(
        InboxChannels.invoke.TRACK_SUGGESTION,
        input.itemId,
        input.itemType,
        input.suggestedTo,
        input.actualTo,
        input.confidence,
        input.suggestedTags || [],
        input.actualTags || []
      ),
    convertToNote: (itemId: string) =>
      ipcRenderer.invoke(InboxChannels.invoke.CONVERT_TO_NOTE, itemId),
    linkToNote: (itemId: string, noteId: string, tags?: string[]) =>
      ipcRenderer.invoke(InboxChannels.invoke.LINK_TO_NOTE, itemId, noteId, tags || []),

    // Tags
    addTag: (itemId: string, tag: string) =>
      ipcRenderer.invoke(InboxChannels.invoke.ADD_TAG, itemId, tag),
    removeTag: (itemId: string, tag: string) =>
      ipcRenderer.invoke(InboxChannels.invoke.REMOVE_TAG, itemId, tag),
    getTags: () => ipcRenderer.invoke(InboxChannels.invoke.GET_TAGS),

    // Snooze
    snooze: (input: { itemId: string; snoozeUntil: string; reason?: string }) =>
      ipcRenderer.invoke(InboxChannels.invoke.SNOOZE, input),
    unsnooze: (itemId: string) => ipcRenderer.invoke(InboxChannels.invoke.UNSNOOZE, itemId),
    getSnoozed: () => ipcRenderer.invoke(InboxChannels.invoke.GET_SNOOZED),
    bulkSnooze: (input: { itemIds: string[]; snoozeUntil: string; reason?: string }) =>
      ipcRenderer.invoke(InboxChannels.invoke.BULK_SNOOZE, input),

    // Viewed (for reminder items)
    markViewed: (itemId: string) => ipcRenderer.invoke(InboxChannels.invoke.MARK_VIEWED, itemId),

    // Bulk operations
    bulkFile: (input: {
      itemIds: string[]
      destination: { type: string; path?: string; noteId?: string }
      tags?: string[]
    }) => ipcRenderer.invoke(InboxChannels.invoke.BULK_FILE, input),
    bulkArchive: (input: { itemIds: string[] }) =>
      ipcRenderer.invoke(InboxChannels.invoke.BULK_ARCHIVE, input),
    bulkTag: (input: { itemIds: string[]; tags: string[] }) =>
      ipcRenderer.invoke(InboxChannels.invoke.BULK_TAG, input),
    fileAllStale: () => ipcRenderer.invoke(InboxChannels.invoke.FILE_ALL_STALE),

    // Transcription
    retryTranscription: (itemId: string) =>
      ipcRenderer.invoke(InboxChannels.invoke.RETRY_TRANSCRIPTION, itemId),

    // Metadata
    retryMetadata: (itemId: string) =>
      ipcRenderer.invoke(InboxChannels.invoke.RETRY_METADATA, itemId),

    // Stats
    getStats: () => ipcRenderer.invoke(InboxChannels.invoke.GET_STATS),
    getPatterns: () => ipcRenderer.invoke(InboxChannels.invoke.GET_PATTERNS),

    // Settings
    getStaleThreshold: () => ipcRenderer.invoke(InboxChannels.invoke.GET_STALE_THRESHOLD),
    setStaleThreshold: (days: number) =>
      ipcRenderer.invoke(InboxChannels.invoke.SET_STALE_THRESHOLD, days)
  },

  // Quick Capture API (global shortcut window)
  quickCapture: {
    /** Close the quick capture window */
    close: (): void => ipcRenderer.send('quick-capture:close'),
    /** Get current clipboard text content */
    getClipboard: (): Promise<string> => ipcRenderer.invoke('quick-capture:get-clipboard')
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
  ): Promise<string | null> => ipcRenderer.invoke('context-menu:show', items),

  // Tags API (for sidebar drill-down)
  tags: {
    /** Get notes for a specific tag with pinned status */
    getNotesByTag: (input: {
      tag: string
      sortBy?: 'modified' | 'created' | 'title'
      sortOrder?: 'asc' | 'desc'
    }) => ipcRenderer.invoke(TagsChannels.invoke.GET_NOTES_BY_TAG, input),
    /** Pin a note to a tag */
    pinNoteToTag: (input: { noteId: string; tag: string }) =>
      ipcRenderer.invoke(TagsChannels.invoke.PIN_NOTE_TO_TAG, input),
    /** Unpin a note from a tag */
    unpinNoteFromTag: (input: { noteId: string; tag: string }) =>
      ipcRenderer.invoke(TagsChannels.invoke.UNPIN_NOTE_FROM_TAG, input),
    /** Rename a tag across all notes */
    renameTag: (input: { oldName: string; newName: string }) =>
      ipcRenderer.invoke(TagsChannels.invoke.RENAME_TAG, input),
    /** Update tag color */
    updateTagColor: (input: { tag: string; color: string }) =>
      ipcRenderer.invoke(TagsChannels.invoke.UPDATE_TAG_COLOR, input),
    /** Delete a tag from all notes */
    deleteTag: (tag: string) => ipcRenderer.invoke(TagsChannels.invoke.DELETE_TAG, tag),
    /** Remove tag from a specific note */
    removeTagFromNote: (input: { noteId: string; tag: string }) =>
      ipcRenderer.invoke(TagsChannels.invoke.REMOVE_TAG_FROM_NOTE, input)
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
    }) => ipcRenderer.invoke(ReminderChannels.invoke.CREATE, input),

    /** Update an existing reminder */
    update: (input: {
      id: string
      remindAt?: string
      title?: string | null
      note?: string | null
    }) => ipcRenderer.invoke(ReminderChannels.invoke.UPDATE, input),

    /** Delete a reminder */
    delete: (id: string) => ipcRenderer.invoke(ReminderChannels.invoke.DELETE, id),

    /** Get a reminder by ID */
    get: (id: string) => ipcRenderer.invoke(ReminderChannels.invoke.GET, id),

    /** List reminders with optional filters */
    list: (options?: {
      targetType?: 'note' | 'journal' | 'highlight'
      targetId?: string
      status?: string | string[]
      fromDate?: string
      toDate?: string
      limit?: number
      offset?: number
    }) => ipcRenderer.invoke(ReminderChannels.invoke.LIST, options ?? {}),

    /** Get upcoming reminders (next N days) */
    getUpcoming: (days?: number) => ipcRenderer.invoke(ReminderChannels.invoke.GET_UPCOMING, days),

    /** Get due reminders */
    getDue: () => ipcRenderer.invoke(ReminderChannels.invoke.GET_DUE),

    /** Get reminders for a specific target */
    getForTarget: (input: { targetType: 'note' | 'journal' | 'highlight'; targetId: string }) =>
      ipcRenderer.invoke(ReminderChannels.invoke.GET_FOR_TARGET, input),

    /** Count pending reminders (for badge) */
    countPending: () => ipcRenderer.invoke(ReminderChannels.invoke.COUNT_PENDING),

    /** Dismiss a reminder */
    dismiss: (id: string) => ipcRenderer.invoke(ReminderChannels.invoke.DISMISS, id),

    /** Snooze a reminder to a later time */
    snooze: (input: { id: string; snoozeUntil: string }) =>
      ipcRenderer.invoke(ReminderChannels.invoke.SNOOZE, input),

    /** Bulk dismiss multiple reminders */
    bulkDismiss: (input: { reminderIds: string[] }) =>
      ipcRenderer.invoke(ReminderChannels.invoke.BULK_DISMISS, input)
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
    getConfig: (folderPath: string) =>
      ipcRenderer.invoke(FolderViewChannels.invoke.GET_CONFIG, { folderPath }),
    /** Set/update folder view configuration */
    setConfig: (folderPath: string, config: Record<string, unknown>) =>
      ipcRenderer.invoke(FolderViewChannels.invoke.SET_CONFIG, { folderPath, config }),
    /** Get all views for a folder */
    getViews: (folderPath: string) =>
      ipcRenderer.invoke(FolderViewChannels.invoke.GET_VIEWS, { folderPath }),
    /** Add or update a single view */
    setView: (folderPath: string, view: Record<string, unknown>) =>
      ipcRenderer.invoke(FolderViewChannels.invoke.SET_VIEW, { folderPath, view }),
    /** Delete a view by name */
    deleteView: (folderPath: string, viewName: string) =>
      ipcRenderer.invoke(FolderViewChannels.invoke.DELETE_VIEW, { folderPath, viewName }),
    /** List notes in folder with property values */
    listWithProperties: (options: {
      folderPath: string
      properties?: string[]
      limit?: number
      offset?: number
    }) => ipcRenderer.invoke(FolderViewChannels.invoke.LIST_WITH_PROPERTIES, options),
    /** Get available properties for column selector */
    getAvailableProperties: (folderPath: string) =>
      ipcRenderer.invoke(FolderViewChannels.invoke.GET_AVAILABLE_PROPERTIES, { folderPath }),
    /** Get AI-powered folder suggestions for moving a note (Phase 27) */
    getFolderSuggestions: (noteId: string) =>
      ipcRenderer.invoke(FolderViewChannels.invoke.GET_FOLDER_SUGGESTIONS, { noteId })
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
  // @ts-ignore (define in dts)
  window.electron = electronAPI
  // @ts-ignore (define in dts)
  window.api = api
}
