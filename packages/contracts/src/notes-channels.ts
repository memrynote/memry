/**
 * Notes IPC Channel Constants
 *
 * Extracted from ipc-channels.ts so that file stays under the repo's
 * 800-line ceiling. Re-exported from ipc-channels.ts for backward
 * compatibility; consumers can keep importing from either path.
 *
 * This file has NO dependencies (no Zod, etc.) so it can be safely
 * imported in preload context.
 *
 * @module shared/notes-channels
 */

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
    /** Ensure a property definition exists (creates with defaults if missing) */
    ENSURE_PROPERTY_DEFINITION: 'notes:ensure-property-definition',
    /** Add an option to a select/multiselect property definition */
    ADD_PROPERTY_OPTION: 'notes:add-property-option',
    /** Add an option to a status property definition within a category */
    ADD_STATUS_OPTION: 'notes:add-status-option',
    /** Remove an option from a property definition */
    REMOVE_PROPERTY_OPTION: 'notes:remove-property-option',
    /** Rename an option in a property definition */
    RENAME_PROPERTY_OPTION: 'notes:rename-property-option',
    /** Update an option's color in a property definition */
    UPDATE_OPTION_COLOR: 'notes:update-option-color',
    /** Delete an entire property definition */
    DELETE_PROPERTY_DEFINITION: 'notes:delete-property-definition',
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
    /** Get preview data for a WikiLink hover card */
    PREVIEW_BY_TITLE: 'notes:preview-by-title',
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
    EXTERNAL_CHANGE: 'notes:external-change',
    /** Folder config (icon, etc.) was updated via sync */
    FOLDER_CONFIG_UPDATED: 'notes:folder-config-updated'
  }
} as const

export type NotesInvokeChannel = (typeof NotesChannels.invoke)[keyof typeof NotesChannels.invoke]
export type NotesEventChannel = (typeof NotesChannels.events)[keyof typeof NotesChannels.events]
