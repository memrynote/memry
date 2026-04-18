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
// NotesChannels lives in ./notes-channels.ts (extracted to stay under the
// 800-line ceiling). Re-exported here so existing imports keep working.

export { NotesChannels } from './notes-channels.ts'

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

export type { NotesInvokeChannel, NotesEventChannel } from './notes-channels.ts'

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
    /** Get voice transcription provider settings */
    GET_VOICE_TRANSCRIPTION_SETTINGS: 'settings:getVoiceTranscriptionSettings',
    /** Set voice transcription provider settings */
    SET_VOICE_TRANSCRIPTION_SETTINGS: 'settings:setVoiceTranscriptionSettings',
    /** Get local voice model status */
    GET_VOICE_MODEL_STATUS: 'settings:getVoiceModelStatus',
    /** Download local voice model */
    DOWNLOAD_VOICE_MODEL: 'settings:downloadVoiceModel',
    /** Check whether the selected voice provider is ready */
    GET_VOICE_RECORDING_READINESS: 'settings:getVoiceRecordingReadiness',
    /** Check whether an OpenAI BYOK secret exists for voice transcription */
    GET_VOICE_TRANSCRIPTION_OPENAI_KEY_STATUS: 'settings:getVoiceTranscriptionOpenAIKeyStatus',
    /** Store or clear the OpenAI BYOK secret for voice transcription */
    SET_VOICE_TRANSCRIPTION_OPENAI_KEY: 'settings:setVoiceTranscriptionOpenAIKey',
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
    /** M2: get Google Calendar defaults (target calendar, onboarding flag, promote-dialog flag) */
    GET_CALENDAR_GOOGLE_SETTINGS: 'settings:getCalendarGoogleSettings',
    /** M2: update Google Calendar defaults (partial merge) */
    SET_CALENDAR_GOOGLE_SETTINGS: 'settings:setCalendarGoogleSettings',
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
    EMBEDDING_PROGRESS: 'settings:embeddingProgress',
    /** Local voice model download/load progress */
    VOICE_MODEL_PROGRESS: 'settings:voiceModelProgress',
    /** Open the settings modal to a specific section */
    OPEN_SECTION: 'settings:openSection'
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
// InboxChannels lives in ./inbox-channels.ts (extracted to stay under the
// 800-line ceiling). Re-exported here so existing imports keep working.

export { InboxChannels } from './inbox-channels.ts'
export type { InboxInvokeChannel, InboxEventChannel } from './inbox-channels.ts'

// ============================================================================
// Calendar Channels
// ============================================================================

export const CalendarChannels = {
  invoke: {
    CREATE_EVENT: 'calendar:create-event',
    GET_EVENT: 'calendar:get-event',
    UPDATE_EVENT: 'calendar:update-event',
    DELETE_EVENT: 'calendar:delete-event',
    LIST_EVENTS: 'calendar:list-events',
    GET_RANGE: 'calendar:get-range',
    LIST_SOURCES: 'calendar:list-sources',
    UPDATE_SOURCE_SELECTION: 'calendar:update-source-selection',
    GET_PROVIDER_STATUS: 'calendar:get-provider-status',
    CONNECT_PROVIDER: 'calendar:connect-provider',
    DISCONNECT_PROVIDER: 'calendar:disconnect-provider',
    REFRESH_PROVIDER: 'calendar:refresh-provider',
    /** M2: copy an external Google event into an editable Memry event */
    PROMOTE_EXTERNAL_EVENT: 'calendar:promote-external-event',
    /** M2: list the user's Google calendars for target/default selection */
    LIST_GOOGLE_CALENDARS: 'calendar:list-google-calendars',
    /** M2: persist the onboarding choice for default target Google calendar */
    SET_DEFAULT_GOOGLE_CALENDAR: 'calendar:set-default-google-calendar'
  },
  events: {
    CHANGED: 'calendar:changed'
  }
} as const

export type CalendarInvokeChannel =
  (typeof CalendarChannels.invoke)[keyof typeof CalendarChannels.invoke]
export type CalendarEventChannel =
  (typeof CalendarChannels.events)[keyof typeof CalendarChannels.events]

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
