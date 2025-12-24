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
    REINDEX: 'vault:reindex'
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
    /** Get properties for a note (T015) */
    GET_PROPERTIES: 'notes:get-properties',
    /** Set properties for a note (T016) */
    SET_PROPERTIES: 'notes:set-properties',
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
    DELETE_ATTACHMENT: 'notes:delete-attachment'
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
// Search Channels
// ============================================================================

export const SearchChannels = {
  invoke: {
    /** Full search with all options */
    SEARCH: 'search:query',
    /** Quick search for command palette / omnibar */
    QUICK_SEARCH: 'search:quick',
    /** Get search suggestions as user types */
    SUGGESTIONS: 'search:suggestions',
    /** Get recent searches */
    GET_RECENT: 'search:get-recent',
    /** Clear recent searches */
    CLEAR_RECENT: 'search:clear-recent',
    /** Add to recent searches */
    ADD_RECENT: 'search:add-recent',
    /** Get search index stats */
    GET_STATS: 'search:get-stats',
    /** Force rebuild search index */
    REBUILD_INDEX: 'search:rebuild-index',
    /** Search notes only (optimized) */
    SEARCH_NOTES: 'search:notes',
    /** Search tasks only (optimized) */
    SEARCH_TASKS: 'search:tasks',
    /** Find notes by tag */
    FIND_BY_TAG: 'search:find-by-tag',
    /** Find notes by backlink */
    FIND_BACKLINKS: 'search:find-backlinks'
  },
  events: {
    /** Index rebuild started */
    INDEX_REBUILD_STARTED: 'search:index-rebuild-started',
    /** Index rebuild progress */
    INDEX_REBUILD_PROGRESS: 'search:index-rebuild-progress',
    /** Index rebuild completed */
    INDEX_REBUILD_COMPLETED: 'search:index-rebuild-completed',
    /** Index corrupted, needs rebuild */
    INDEX_CORRUPT: 'search:index-corrupt'
  }
} as const

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
// Type Exports
// ============================================================================

export type VaultInvokeChannel = (typeof VaultChannels.invoke)[keyof typeof VaultChannels.invoke]
export type VaultEventChannel = (typeof VaultChannels.events)[keyof typeof VaultChannels.events]

export type NotesInvokeChannel = (typeof NotesChannels.invoke)[keyof typeof NotesChannels.invoke]
export type NotesEventChannel = (typeof NotesChannels.events)[keyof typeof NotesChannels.events]

export type SearchInvokeChannel = (typeof SearchChannels.invoke)[keyof typeof SearchChannels.invoke]
export type SearchEventChannel = (typeof SearchChannels.events)[keyof typeof SearchChannels.events]

export type TasksInvokeChannel = (typeof TasksChannels.invoke)[keyof typeof TasksChannels.invoke]
export type TasksEventChannel = (typeof TasksChannels.events)[keyof typeof TasksChannels.events]

export type SavedFiltersInvokeChannel =
  (typeof SavedFiltersChannels.invoke)[keyof typeof SavedFiltersChannels.invoke]
export type SavedFiltersEventChannel =
  (typeof SavedFiltersChannels.events)[keyof typeof SavedFiltersChannels.events]
