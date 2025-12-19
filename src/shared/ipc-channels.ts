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
    REVEAL_IN_FINDER: 'notes:reveal-in-finder'
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
// Type Exports
// ============================================================================

export type VaultInvokeChannel = (typeof VaultChannels.invoke)[keyof typeof VaultChannels.invoke]
export type VaultEventChannel = (typeof VaultChannels.events)[keyof typeof VaultChannels.events]

export type NotesInvokeChannel = (typeof NotesChannels.invoke)[keyof typeof NotesChannels.invoke]
export type NotesEventChannel = (typeof NotesChannels.events)[keyof typeof NotesChannels.events]

export type SearchInvokeChannel = (typeof SearchChannels.invoke)[keyof typeof SearchChannels.invoke]
export type SearchEventChannel = (typeof SearchChannels.events)[keyof typeof SearchChannels.events]
