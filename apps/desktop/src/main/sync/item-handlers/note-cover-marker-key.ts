/**
 * The `sync_state` key prefix of a note's cover sync marker, one row per note.
 * A leaf module, so sign-out's keep-set reads it without loading the data
 * schema.
 */
export const COVER_MARKER_KEY_PREFIX = 'note-cover:'
