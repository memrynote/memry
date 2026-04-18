/**
 * Inbox IPC Channel Constants
 *
 * Extracted from ipc-channels.ts so that file stays under the repo's
 * 800-line ceiling. Re-exported from ipc-channels.ts for backward
 * compatibility; consumers can keep importing from either path.
 *
 * This file has NO dependencies (no Zod, etc.) so it can be safely
 * imported in preload context.
 *
 * @module shared/inbox-channels
 */

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
    /** List durable inbox jobs */
    GET_JOBS: 'inbox:get-jobs',
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
