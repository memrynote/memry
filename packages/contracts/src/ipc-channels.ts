/**
 * IPC Channel Constants
 *
 * Single source of truth for all IPC channel names.
 * This file has NO dependencies (no Zod, etc.) so it can be safely
 * imported in preload context.
 *
 * @module shared/ipc-channels
 */

// ============================================================================
// Vault Channels
// ============================================================================

export const VaultChannels = {
  invoke: {
    SELECT: 'vault:select',
    CREATE: 'vault:create',
    GET_ALL: 'vault:get-all',
    GET_STATUS: 'vault:get-status',
    GET_CONFIG: 'vault:get-config',
    UPDATE_CONFIG: 'vault:update-config',
    CLOSE: 'vault:close',
    SWITCH: 'vault:switch',
    REMOVE: 'vault:remove',
    REINDEX: 'vault:reindex',
    /** Reveal vault folder in OS file manager */
    REVEAL: 'vault:reveal'
  },
  events: {
    STATUS_CHANGED: 'vault:status-changed',
    INDEX_PROGRESS: 'vault:index-progress',
    INDEX_RECOVERED: 'vault:index-recovered',
    ERROR: 'vault:error'
  }
} as const

// ============================================================================
// Notes Channels
// ============================================================================

export const NotesChannels = {
  invoke: {
    /** Create a new note */
    CREATE: 'notes:create',
    /** Get a note by ID */
    GET: 'notes:get',
    /** Get a note by path */
    GET_BY_PATH: 'notes:get-by-path',
    /** Update note content/metadata */
    UPDATE: 'notes:update',
    /** Rename a note (changes filename) */
    RENAME: 'notes:rename',
    /** Move note to different folder */
    MOVE: 'notes:move',
    /** Delete a note */
    DELETE: 'notes:delete',
    /** List notes with filtering */
    LIST: 'notes:list',
    /** Get all tags used in notes */
    GET_TAGS: 'notes:get-tags',
    /** Get note links (outgoing and incoming) */
    GET_LINKS: 'notes:get-links',
    /** Get folder structure */
    GET_FOLDERS: 'notes:get-folders',
    /** Create a new folder */
    CREATE_FOLDER: 'notes:create-folder',
    /** Rename a folder */
    RENAME_FOLDER: 'notes:rename-folder',
    /** Delete a folder (recursive) */
    DELETE_FOLDER: 'notes:delete-folder',
    /** Check if note exists */
    EXISTS: 'notes:exists',
    /** Open note in external editor */
    OPEN_EXTERNAL: 'notes:open-external',
    /** Reveal note in file explorer */
    REVEAL_IN_FINDER: 'notes:reveal-in-finder',
    /** Get all property definitions (T017) */
    GET_PROPERTY_DEFINITIONS: 'notes:get-property-definitions',
    /** Create a property definition (T018) */
    CREATE_PROPERTY_DEFINITION: 'notes:create-property-definition',
    /** Update a property definition */
    UPDATE_PROPERTY_DEFINITION: 'notes:update-property-definition',
    /** Upload an attachment to a note (T070) */
    UPLOAD_ATTACHMENT: 'notes:upload-attachment',
    /** List attachments for a note */
    LIST_ATTACHMENTS: 'notes:list-attachments',
    /** Delete an attachment */
    DELETE_ATTACHMENT: 'notes:delete-attachment',
    /** Get folder config (template settings) */
    GET_FOLDER_CONFIG: 'notes:get-folder-config',
    /** Set folder config (template settings) */
    SET_FOLDER_CONFIG: 'notes:set-folder-config',
    /** Get resolved folder template (with inheritance) */
    GET_FOLDER_TEMPLATE: 'notes:get-folder-template',
    /** Export note as PDF (T106) */
    EXPORT_PDF: 'notes:export-pdf',
    /** Export note as HTML (T108) */
    EXPORT_HTML: 'notes:export-html',
    /** Get version history for a note (T114) */
    GET_VERSIONS: 'notes:get-versions',
    /** Get a specific version/snapshot (T114) */
    GET_VERSION: 'notes:get-version',
    /** Restore a note from a version (T114) */
    RESTORE_VERSION: 'notes:restore-version',
    /** Delete a specific version (T114) */
    DELETE_VERSION: 'notes:delete-version',
    /** Get note positions in a folder */
    GET_POSITIONS: 'notes:get-positions',
    /** Get all note positions */
    GET_ALL_POSITIONS: 'notes:get-all-positions',
    /** Reorder notes in a folder */
    REORDER: 'notes:reorder',
    /** Get file metadata by ID (for non-markdown files) */
    GET_FILE: 'notes:get-file',
    /** Resolve a WikiLink target by title (returns note or file metadata) */
    RESOLVE_BY_TITLE: 'notes:resolve-by-title',
    /** Import files from external paths into the vault */
    IMPORT_FILES: 'notes:import-files',
    /** Open a file dialog to select files for import */
    SHOW_IMPORT_DIALOG: 'notes:show-import-dialog',
    /** Toggle local-only flag (excludes note from sync) */
    SET_LOCAL_ONLY: 'notes:set-local-only',
    /** Get count of local-only notes */
    GET_LOCAL_ONLY_COUNT: 'notes:get-local-only-count'
  },
  events: {
    /** Note was created (externally or internally) */
    CREATED: 'notes:created',
    /** Note was updated */
    UPDATED: 'notes:updated',
    /** Note was deleted */
    DELETED: 'notes:deleted',
    /** Note was renamed */
    RENAMED: 'notes:renamed',
    /** Note was moved */
    MOVED: 'notes:moved',
    /** External change detected */
    EXTERNAL_CHANGE: 'notes:external-change'
  }
} as const

// ============================================================================
// Tags Channels (Tag Management & Drill-Down)
// ============================================================================

export const TagsChannels = {
  invoke: {
    /** Get notes for a specific tag with pinned info */
    GET_NOTES_BY_TAG: 'tags:get-notes-by-tag',
    /** Pin a note to a tag */
    PIN_NOTE_TO_TAG: 'tags:pin-note-to-tag',
    /** Unpin a note from a tag */
    UNPIN_NOTE_FROM_TAG: 'tags:unpin-note-from-tag',
    /** Rename a tag across all notes */
    RENAME_TAG: 'tags:rename',
    /** Update tag color */
    UPDATE_TAG_COLOR: 'tags:update-color',
    /** Delete a tag from all notes */
    DELETE_TAG: 'tags:delete',
    /** Remove tag from a specific note */
    REMOVE_TAG_FROM_NOTE: 'tags:remove-from-note',
    /** Get all tags with usage counts across notes + tasks */
    GET_ALL_WITH_COUNTS: 'tags:get-all-with-counts',
    /** Merge source tag into target tag (rename + deduplicate) */
    MERGE_TAG: 'tags:merge'
  },
  events: {
    /** Tag was renamed */
    RENAMED: 'tags:renamed',
    /** Tag color was updated */
    COLOR_UPDATED: 'tags:color-updated',
    /** Tag was deleted */
    DELETED: 'tags:deleted',
    /** Notes for a tag changed (pin/unpin, add/remove) */
    NOTES_CHANGED: 'tags:notes-changed'
  }
} as const

export type TagsInvokeChannel = (typeof TagsChannels.invoke)[keyof typeof TagsChannels.invoke]
export type TagsEventChannel = (typeof TagsChannels.events)[keyof typeof TagsChannels.events]

// ============================================================================
// Tasks Channels
// ============================================================================

export const TasksChannels = {
  invoke: {
    // Task operations
    CREATE: 'tasks:create',
    GET: 'tasks:get',
    UPDATE: 'tasks:update',
    DELETE: 'tasks:delete',
    LIST: 'tasks:list',
    COMPLETE: 'tasks:complete',
    UNCOMPLETE: 'tasks:uncomplete',
    ARCHIVE: 'tasks:archive',
    UNARCHIVE: 'tasks:unarchive',
    MOVE: 'tasks:move',
    REORDER: 'tasks:reorder',
    DUPLICATE: 'tasks:duplicate',

    // Subtask operations
    GET_SUBTASKS: 'tasks:get-subtasks',
    CONVERT_TO_SUBTASK: 'tasks:convert-to-subtask',
    CONVERT_TO_TASK: 'tasks:convert-to-task',

    // Project operations
    PROJECT_CREATE: 'tasks:project-create',
    PROJECT_GET: 'tasks:project-get',
    PROJECT_UPDATE: 'tasks:project-update',
    PROJECT_DELETE: 'tasks:project-delete',
    PROJECT_LIST: 'tasks:project-list',
    PROJECT_ARCHIVE: 'tasks:project-archive',
    PROJECT_REORDER: 'tasks:project-reorder',

    // Status operations
    STATUS_CREATE: 'tasks:status-create',
    STATUS_UPDATE: 'tasks:status-update',
    STATUS_DELETE: 'tasks:status-delete',
    STATUS_REORDER: 'tasks:status-reorder',
    STATUS_LIST: 'tasks:status-list',

    // Tag operations
    GET_TAGS: 'tasks:get-tags',

    // Bulk operations
    BULK_COMPLETE: 'tasks:bulk-complete',
    BULK_DELETE: 'tasks:bulk-delete',
    BULK_MOVE: 'tasks:bulk-move',
    BULK_ARCHIVE: 'tasks:bulk-archive',

    // Stats and views
    GET_STATS: 'tasks:get-stats',
    GET_TODAY: 'tasks:get-today',
    GET_UPCOMING: 'tasks:get-upcoming',
    GET_OVERDUE: 'tasks:get-overdue',

    // Note linking
    GET_LINKED_TASKS: 'tasks:get-linked-tasks'
  },
  events: {
    CREATED: 'tasks:created',
    UPDATED: 'tasks:updated',
    DELETED: 'tasks:deleted',
    COMPLETED: 'tasks:completed',
    MOVED: 'tasks:moved',
    PROJECT_CREATED: 'tasks:project-created',
    PROJECT_UPDATED: 'tasks:project-updated',
    PROJECT_DELETED: 'tasks:project-deleted'
  }
} as const

// ============================================================================
// Saved Filters Channels
// ============================================================================

export const SavedFiltersChannels = {
  invoke: {
    LIST: 'saved-filters:list',
    CREATE: 'saved-filters:create',
    UPDATE: 'saved-filters:update',
    DELETE: 'saved-filters:delete',
    REORDER: 'saved-filters:reorder'
  },
  events: {
    CREATED: 'saved-filters:created',
    UPDATED: 'saved-filters:updated',
    DELETED: 'saved-filters:deleted'
  }
} as const

// ============================================================================
// Templates Channels
// ============================================================================

export const TemplatesChannels = {
  invoke: {
    /** List all templates */
    LIST: 'templates:list',
    /** Get a template by ID */
    GET: 'templates:get',
    /** Create a new template */
    CREATE: 'templates:create',
    /** Update an existing template */
    UPDATE: 'templates:update',
    /** Delete a template */
    DELETE: 'templates:delete',
    /** Duplicate a template */
    DUPLICATE: 'templates:duplicate'
  },
  events: {
    /** Template was created */
    CREATED: 'templates:created',
    /** Template was updated */
    UPDATED: 'templates:updated',
    /** Template was deleted */
    DELETED: 'templates:deleted'
  }
} as const

// ============================================================================
// Properties Channels (Unified for Notes & Journal)
// ============================================================================

export const PropertiesChannels = {
  invoke: {
    /** Get properties for any entity (note or journal) by ID */
    GET: 'properties:get',
    /** Set properties for any entity (note or journal) by ID */
    SET: 'properties:set',
    /** Rename a property for a specific entity (note-only scope) */
    RENAME: 'properties:rename'
  }
} as const

export type PropertiesInvokeChannel =
  (typeof PropertiesChannels.invoke)[keyof typeof PropertiesChannels.invoke]

// ============================================================================
// Type Exports
// ============================================================================

export type VaultInvokeChannel = (typeof VaultChannels.invoke)[keyof typeof VaultChannels.invoke]
export type VaultEventChannel = (typeof VaultChannels.events)[keyof typeof VaultChannels.events]

export type NotesInvokeChannel = (typeof NotesChannels.invoke)[keyof typeof NotesChannels.invoke]
export type NotesEventChannel = (typeof NotesChannels.events)[keyof typeof NotesChannels.events]

export type TasksInvokeChannel = (typeof TasksChannels.invoke)[keyof typeof TasksChannels.invoke]
export type TasksEventChannel = (typeof TasksChannels.events)[keyof typeof TasksChannels.events]

export type SavedFiltersInvokeChannel =
  (typeof SavedFiltersChannels.invoke)[keyof typeof SavedFiltersChannels.invoke]
export type SavedFiltersEventChannel =
  (typeof SavedFiltersChannels.events)[keyof typeof SavedFiltersChannels.events]

export type TemplatesInvokeChannel =
  (typeof TemplatesChannels.invoke)[keyof typeof TemplatesChannels.invoke]
export type TemplatesEventChannel =
  (typeof TemplatesChannels.events)[keyof typeof TemplatesChannels.events]

// ============================================================================
// Journal Channels
// ============================================================================

export const JournalChannels = {
  invoke: {
    // Entry CRUD
    /** Get a journal entry by date */
    GET_ENTRY: 'journal:getEntry',
    /** Create a new journal entry */
    CREATE_ENTRY: 'journal:createEntry',
    /** Update an existing journal entry */
    UPDATE_ENTRY: 'journal:updateEntry',
    /** Delete a journal entry */
    DELETE_ENTRY: 'journal:deleteEntry',

    // Calendar & Views
    /** Get heatmap data for a year */
    GET_HEATMAP: 'journal:getHeatmap',
    /** Get entries for a specific month */
    GET_MONTH_ENTRIES: 'journal:getMonthEntries',
    /** Get stats for all months in a year */
    GET_YEAR_STATS: 'journal:getYearStats',

    // Context
    /** Get tasks and events for a specific date */
    GET_DAY_CONTEXT: 'journal:getDayContext',

    // Tags
    /** Get all tags used in journal entries */
    GET_ALL_TAGS: 'journal:getAllTags',

    // Streak
    /** Get current and longest streak */
    GET_STREAK: 'journal:getStreak'
  },
  events: {
    /** Journal entry was created */
    ENTRY_CREATED: 'journal:entryCreated',
    /** Journal entry was updated */
    ENTRY_UPDATED: 'journal:entryUpdated',
    /** Journal entry was deleted */
    ENTRY_DELETED: 'journal:entryDeleted',
    /** External change detected to journal file */
    EXTERNAL_CHANGE: 'journal:externalChange'
  }
} as const

export type JournalInvokeChannel =
  (typeof JournalChannels.invoke)[keyof typeof JournalChannels.invoke]
export type JournalEventChannel =
  (typeof JournalChannels.events)[keyof typeof JournalChannels.events]

// ============================================================================
// Settings Channels
// ============================================================================

export const SettingsChannels = {
  invoke: {
    /** Get a setting by key */
    GET: 'settings:get',
    /** Set a setting value */
    SET: 'settings:set',
    /** Get journal settings */
    GET_JOURNAL_SETTINGS: 'settings:getJournalSettings',
    /** Set journal settings */
    SET_JOURNAL_SETTINGS: 'settings:setJournalSettings',
    /** Get AI settings (enabled flag) */
    GET_AI_SETTINGS: 'settings:getAISettings',
    /** Set AI settings */
    SET_AI_SETTINGS: 'settings:setAISettings',
    /** Get AI model status (loaded, loading, error, etc.) */
    GET_AI_MODEL_STATUS: 'settings:getAIModelStatus',
    /** Load AI embedding model */
    LOAD_AI_MODEL: 'settings:loadAIModel',
    /** Trigger re-indexing of note embeddings */
    REINDEX_EMBEDDINGS: 'settings:reindexEmbeddings',
    /** Get tab settings (preview mode, etc.) */
    GET_TAB_SETTINGS: 'settings:getTabSettings',
    /** Set tab settings */
    SET_TAB_SETTINGS: 'settings:setTabSettings',
    /** Get note editor settings (toolbar mode, etc.) */
    GET_NOTE_EDITOR_SETTINGS: 'settings:getNoteEditorSettings',
    /** Set note editor settings */
    SET_NOTE_EDITOR_SETTINGS: 'settings:setNoteEditorSettings',

    // --- Settings System: new group channels ---

    /** Get general appearance settings (theme, font, accent) */
    GET_GENERAL_SETTINGS: 'settings:getGeneralSettings',
    /** Update general appearance settings (partial merge) */
    SET_GENERAL_SETTINGS: 'settings:setGeneralSettings',
    /** Get editor settings (width, spellcheck, autosave) */
    GET_EDITOR_SETTINGS: 'settings:getEditorSettings',
    /** Update editor settings (partial merge) */
    SET_EDITOR_SETTINGS: 'settings:setEditorSettings',
    /** Get task preference settings */
    GET_TASK_SETTINGS: 'settings:getTaskSettings',
    /** Update task preference settings (partial merge) */
    SET_TASK_SETTINGS: 'settings:setTaskSettings',
    /** Get keyboard shortcut overrides */
    GET_KEYBOARD_SETTINGS: 'settings:getKeyboardSettings',
    /** Update keyboard shortcut overrides (partial merge) */
    SET_KEYBOARD_SETTINGS: 'settings:setKeyboardSettings',
    /** Reset all keyboard shortcuts to defaults */
    RESET_KEYBOARD_SETTINGS: 'settings:resetKeyboardSettings',
    /** Get sync toggle settings */
    GET_SYNC_SETTINGS: 'settings:getSyncSettings',
    /** Update sync toggle settings */
    SET_SYNC_SETTINGS: 'settings:setSyncSettings',
    /** Get backup configuration */
    GET_BACKUP_SETTINGS: 'settings:getBackupSettings',
    /** Update backup configuration */
    SET_BACKUP_SETTINGS: 'settings:setBackupSettings',
    /** Store API key in OS keychain (never in DB) */
    SET_API_KEY: 'settings:setApiKey',
    /** Test API provider connection */
    TEST_API_CONNECTION: 'settings:testApiConnection',
    /** Get graph view settings */
    GET_GRAPH_SETTINGS: 'settings:getGraphSettings',
    /** Update graph view settings */
    SET_GRAPH_SETTINGS: 'settings:setGraphSettings',
    /** Reset all settings to defaults */
    RESET_ALL: 'settings:resetAll',
    /** Trigger manual sync */
    TRIGGER_SYNC: 'settings:triggerSync',
    /** Register (or unregister) the OS-level global capture shortcut */
    REGISTER_GLOBAL_CAPTURE: 'settings:registerGlobalCapture'
  },
  sync: {
    /** Get the saved startup theme synchronously for first-paint bootstrap */
    GET_STARTUP_THEME: 'settings:getStartupThemeSync'
  },
  events: {
    /** Settings changed */
    CHANGED: 'settings:changed',
    /** Embedding indexing progress */
    EMBEDDING_PROGRESS: 'settings:embeddingProgress'
  }
} as const

export type SettingsInvokeChannel =
  (typeof SettingsChannels.invoke)[keyof typeof SettingsChannels.invoke]
export type SettingsSyncChannel = (typeof SettingsChannels.sync)[keyof typeof SettingsChannels.sync]
export type SettingsEventChannel =
  (typeof SettingsChannels.events)[keyof typeof SettingsChannels.events]

// ============================================================================
// Account Channels
// ============================================================================

export const AccountChannels = {
  invoke: {
    /** Get account info (email, provider, storage usage) */
    GET_INFO: 'account:getInfo',
    /** Sign out and clear local synced data */
    SIGN_OUT: 'account:signOut',
    /** Get recovery key (requires re-auth token) */
    GET_RECOVERY_KEY: 'account:getRecoveryKey'
  }
} as const

export type AccountInvokeChannel =
  (typeof AccountChannels.invoke)[keyof typeof AccountChannels.invoke]

// ============================================================================
// Data Management Channels
// ============================================================================

export const DataChannels = {
  invoke: {
    /** Get current vault file path */
    GET_VAULT_LOCATION: 'data:getVaultLocation',
    /** Move vault to a new location (atomic with rollback) */
    CHANGE_VAULT_LOCATION: 'data:changeVaultLocation',
    /** Export all data to portable format */
    EXPORT: 'data:export',
    /** Import data from external format */
    IMPORT: 'data:import',
    /** Clear application cache */
    CLEAR_CACHE: 'data:clearCache',
    /** Rebuild search index */
    REBUILD_INDEX: 'data:rebuildIndex',
    /** Get backup history (list of backup files) */
    GET_BACKUP_HISTORY: 'data:getBackupHistory',
    /** Trigger a manual backup */
    TRIGGER_BACKUP: 'data:triggerBackup'
  },
  events: {
    /** Vault move progress */
    VAULT_CHANGE_PROGRESS: 'data:vaultChangeProgress',
    /** Data export progress */
    EXPORT_PROGRESS: 'data:exportProgress',
    /** Data import progress */
    IMPORT_PROGRESS: 'data:importProgress'
  }
} as const

export type DataInvokeChannel = (typeof DataChannels.invoke)[keyof typeof DataChannels.invoke]
export type DataEventChannel = (typeof DataChannels.events)[keyof typeof DataChannels.events]

// ============================================================================
// Bookmarks Channels
// ============================================================================

export const BookmarksChannels = {
  invoke: {
    /** Create a new bookmark */
    CREATE: 'bookmarks:create',
    /** Delete a bookmark by ID */
    DELETE: 'bookmarks:delete',
    /** Get a bookmark by ID */
    GET: 'bookmarks:get',
    /** List bookmarks with optional filters */
    LIST: 'bookmarks:list',
    /** Check if an item is bookmarked */
    IS_BOOKMARKED: 'bookmarks:is-bookmarked',
    /** Toggle bookmark status (create or delete) */
    TOGGLE: 'bookmarks:toggle',
    /** Reorder bookmarks */
    REORDER: 'bookmarks:reorder',
    /** List bookmarks by item type */
    LIST_BY_TYPE: 'bookmarks:list-by-type',
    /** Get bookmark for a specific item */
    GET_BY_ITEM: 'bookmarks:get-by-item',
    /** Delete multiple bookmarks */
    BULK_DELETE: 'bookmarks:bulk-delete',
    /** Create multiple bookmarks */
    BULK_CREATE: 'bookmarks:bulk-create'
  },
  events: {
    /** Bookmark was created */
    CREATED: 'bookmarks:created',
    /** Bookmark was deleted */
    DELETED: 'bookmarks:deleted',
    /** Bookmarks were reordered */
    REORDERED: 'bookmarks:reordered'
  }
} as const

export type BookmarksInvokeChannel =
  (typeof BookmarksChannels.invoke)[keyof typeof BookmarksChannels.invoke]
export type BookmarksEventChannel =
  (typeof BookmarksChannels.events)[keyof typeof BookmarksChannels.events]

// ============================================================================
// Inbox Channels
// ============================================================================

export const InboxChannels = {
  invoke: {
    // Capture operations
    /** Capture text content */
    CAPTURE_TEXT: 'inbox:capture-text',
    /** Capture a URL with metadata extraction */
    CAPTURE_LINK: 'inbox:capture-link',
    /** Preview link metadata without creating inbox item */
    PREVIEW_LINK: 'inbox:preview-link',
    /** Capture an image (from drag-drop or clipboard) */
    CAPTURE_IMAGE: 'inbox:capture-image',
    /** Capture a voice recording */
    CAPTURE_VOICE: 'inbox:capture-voice',
    /** Capture a web clip (selected text from page) */
    CAPTURE_CLIP: 'inbox:capture-clip',
    /** Capture a PDF file */
    CAPTURE_PDF: 'inbox:capture-pdf',

    // CRUD operations
    /** Get a single inbox item by ID */
    GET: 'inbox:get',
    /** List inbox items with filtering */
    LIST: 'inbox:list',
    /** Update an inbox item */
    UPDATE: 'inbox:update',
    /** Archive an inbox item (soft delete) */
    ARCHIVE: 'inbox:archive',

    // Filing operations
    /** File an item to a folder or note */
    FILE: 'inbox:file',
    /** Get filing suggestions for an item */
    GET_SUGGESTIONS: 'inbox:get-suggestions',
    /** Track suggestion feedback (accepted/rejected) */
    TRACK_SUGGESTION: 'inbox:track-suggestion',
    /** Convert an item to a full note */
    CONVERT_TO_NOTE: 'inbox:convert-to-note',
    /** Convert an inbox item to a task */
    CONVERT_TO_TASK: 'inbox:convert-to-task',
    /** Link an item to an existing note */
    LINK_TO_NOTE: 'inbox:link-to-note',

    // Tag operations
    /** Add tag to item */
    ADD_TAG: 'inbox:add-tag',
    /** Remove tag from item */
    REMOVE_TAG: 'inbox:remove-tag',
    /** Get all tags used in inbox */
    GET_TAGS: 'inbox:get-tags',

    // Snooze operations
    /** Snooze an item */
    SNOOZE: 'inbox:snooze',
    /** Unsnooze an item */
    UNSNOOZE: 'inbox:unsnooze',
    /** Get all snoozed items */
    GET_SNOOZED: 'inbox:get-snoozed',
    /** Bulk snooze multiple items */
    BULK_SNOOZE: 'inbox:bulk-snooze',

    // Viewed operations (for reminder items)
    /** Mark an inbox item as viewed */
    MARK_VIEWED: 'inbox:mark-viewed',

    // Bulk operations
    /** Bulk file multiple items */
    BULK_FILE: 'inbox:bulk-file',
    /** Bulk archive multiple items */
    BULK_ARCHIVE: 'inbox:bulk-archive',
    /** Bulk tag multiple items */
    BULK_TAG: 'inbox:bulk-tag',
    /** File all stale items to unsorted */
    FILE_ALL_STALE: 'inbox:file-all-stale',
    // Transcription
    /** Retry transcription for a voice item */
    RETRY_TRANSCRIPTION: 'inbox:retry-transcription',

    // Metadata
    /** Retry metadata fetch for a link item */
    RETRY_METADATA: 'inbox:retry-metadata',

    // Stats
    /** Get inbox statistics */
    GET_STATS: 'inbox:get-stats',
    /** Get capture patterns/insights */
    GET_PATTERNS: 'inbox:get-patterns',

    // Settings
    /** Get stale threshold setting */
    GET_STALE_THRESHOLD: 'inbox:get-stale-threshold',
    /** Set stale threshold setting */
    SET_STALE_THRESHOLD: 'inbox:set-stale-threshold',

    // Archived items
    /** List archived inbox items */
    LIST_ARCHIVED: 'inbox:list-archived',
    /** Unarchive an inbox item (restore to active) */
    UNARCHIVE: 'inbox:unarchive',
    /** Permanently delete an inbox item */
    DELETE_PERMANENT: 'inbox:delete-permanent',

    // Filing history
    /** Get recent filing history entries */
    GET_FILING_HISTORY: 'inbox:get-filing-history',

    // Undo operations
    /** Undo a file action (revert filedAt/filedTo/filedAction to null) */
    UNDO_FILE: 'inbox:undo-file',
    /** Undo an archive action (revert archivedAt to null) */
    UNDO_ARCHIVE: 'inbox:undo-archive'
  },
  events: {
    /** Item was captured */
    CAPTURED: 'inbox:captured',
    /** Item was updated */
    UPDATED: 'inbox:updated',
    /** Item was archived */
    ARCHIVED: 'inbox:archived',
    /** Item was filed */
    FILED: 'inbox:filed',
    /** Item was snoozed */
    SNOOZED: 'inbox:snoozed',
    /** Snoozed item became due */
    SNOOZE_DUE: 'inbox:snooze-due',
    /** Transcription completed */
    TRANSCRIPTION_COMPLETE: 'inbox:transcription-complete',
    /** Metadata fetch completed */
    METADATA_COMPLETE: 'inbox:metadata-complete',
    /** Processing error occurred */
    PROCESSING_ERROR: 'inbox:processing-error'
  }
} as const

export type InboxInvokeChannel = (typeof InboxChannels.invoke)[keyof typeof InboxChannels.invoke]
export type InboxEventChannel = (typeof InboxChannels.events)[keyof typeof InboxChannels.events]

// ============================================================================
// Reminder Channels
// ============================================================================

export const ReminderChannels = {
  invoke: {
    /** Create a new reminder */
    CREATE: 'reminder:create',
    /** Update an existing reminder */
    UPDATE: 'reminder:update',
    /** Delete a reminder */
    DELETE: 'reminder:delete',
    /** Get a reminder by ID */
    GET: 'reminder:get',
    /** List reminders with filters */
    LIST: 'reminder:list',
    /** Get upcoming reminders */
    GET_UPCOMING: 'reminder:get-upcoming',
    /** Get due reminders */
    GET_DUE: 'reminder:get-due',
    /** Get reminders for a specific target */
    GET_FOR_TARGET: 'reminder:get-for-target',
    /** Dismiss a reminder */
    DISMISS: 'reminder:dismiss',
    /** Snooze a reminder */
    SNOOZE: 'reminder:snooze',
    /** Bulk dismiss reminders */
    BULK_DISMISS: 'reminder:bulk-dismiss',
    /** Count pending reminders */
    COUNT_PENDING: 'reminder:count-pending'
  },
  events: {
    /** Reminder was created */
    CREATED: 'reminder:created',
    /** Reminder was updated */
    UPDATED: 'reminder:updated',
    /** Reminder was deleted */
    DELETED: 'reminder:deleted',
    /** Reminder became due */
    DUE: 'reminder:due',
    /** Reminder was dismissed */
    DISMISSED: 'reminder:dismissed',
    /** Reminder was snoozed */
    SNOOZED: 'reminder:snoozed',
    /** Desktop notification was clicked - navigate to reminder target */
    CLICKED: 'reminder:clicked'
  }
} as const

export type ReminderInvokeChannel =
  (typeof ReminderChannels.invoke)[keyof typeof ReminderChannels.invoke]
export type ReminderEventChannel =
  (typeof ReminderChannels.events)[keyof typeof ReminderChannels.events]

// ============================================================================
// Search Channels
// ============================================================================

export const SearchChannels = {
  invoke: {
    /** Full cross-type search with filters */
    QUERY: 'search:query',
    /** Fast search for command palette (limited results, no filters) */
    QUICK: 'search:quick',
    /** Get aggregate counts for all indexed content */
    GET_STATS: 'search:get-stats',
    /** Trigger full index rebuild (all types) */
    REBUILD_INDEX: 'search:rebuild-index',
    /** Get search reasons (visited items) */
    GET_REASONS: 'search:get-reasons',
    /** Add a search reason (item visited from search) */
    ADD_REASON: 'search:add-reason',
    /** Clear all search reasons */
    CLEAR_REASONS: 'search:clear-reasons',
    /** Get all tags across all content types */
    GET_ALL_TAGS: 'search:get-all-tags'
  },
  events: {
    /** Index rebuild has started */
    INDEX_REBUILD_STARTED: 'search:index-rebuild-started',
    /** Index rebuild progress update */
    INDEX_REBUILD_PROGRESS: 'search:index-rebuild-progress',
    /** Index rebuild completed successfully */
    INDEX_REBUILD_COMPLETED: 'search:index-rebuild-completed',
    /** Index corruption detected */
    INDEX_CORRUPT: 'search:index-corrupt'
  }
} as const

export type SearchInvokeChannel = (typeof SearchChannels.invoke)[keyof typeof SearchChannels.invoke]
export type SearchEventChannel = (typeof SearchChannels.events)[keyof typeof SearchChannels.events]

// ============================================================================
// Folder View Channels (Bases-like database view)
// ============================================================================

export const FolderViewChannels = {
  invoke: {
    /** Get folder view configuration (reads .folder.md) */
    GET_CONFIG: 'folder-view:get-config',
    /** Set/update folder view configuration (writes .folder.md) */
    SET_CONFIG: 'folder-view:set-config',
    /** Get all views for a folder */
    GET_VIEWS: 'folder-view:get-views',
    /** Add or update a single view */
    SET_VIEW: 'folder-view:set-view',
    /** Delete a view by name */
    DELETE_VIEW: 'folder-view:delete-view',
    /** List notes in folder with property values */
    LIST_WITH_PROPERTIES: 'folder-view:list-with-properties',
    /** Get available properties for column selector */
    GET_AVAILABLE_PROPERTIES: 'folder-view:get-available-properties',
    /** Get AI-powered folder suggestions for moving a note (T134) */
    GET_FOLDER_SUGGESTIONS: 'folder-view:get-folder-suggestions',
    /** Check if a folder exists (T115) */
    FOLDER_EXISTS: 'folder-view:folder-exists'
  },
  events: {
    /** Folder view config was updated (external file change) */
    CONFIG_UPDATED: 'folder-view:config-updated'
  }
} as const

export type FolderViewInvokeChannel =
  (typeof FolderViewChannels.invoke)[keyof typeof FolderViewChannels.invoke]
export type FolderViewEventChannel =
  (typeof FolderViewChannels.events)[keyof typeof FolderViewChannels.events]

// ============================================================================
// Graph Channels
// ============================================================================

export const GraphChannels = {
  invoke: {
    /** Get full graph data (all nodes + edges) */
    GET_GRAPH_DATA: 'graph:get-graph-data',
    /** Get local graph around a specific note */
    GET_LOCAL_GRAPH: 'graph:get-local-graph'
  }
} as const

export type GraphInvokeChannel = (typeof GraphChannels.invoke)[keyof typeof GraphChannels.invoke]
