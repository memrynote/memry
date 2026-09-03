/**
 * `meta` keys shared across modules.
 *
 * They live here rather than being spelled out at each site because a key
 * written by one module and read by another is a contract, and a typo in one
 * half of it fails silently — the reader simply never finds the row.
 */

/** Markdown to seed a locally-created note's editor with, until it lands. */
export const seedKey = (noteId: string) => `seed.${noteId}`

/** The queries the search entry screen offers back, most recent first. */
export const RECENT_SEARCHES_KEY = 'search.recent'

/** The notes list's sort mode; absent means `MOBILE_SORT_DEFAULT`. */
export const NOTES_SORT_KEY = 'notes.sort'

/** The notes tree's open folder paths as a JSON array; absent means all closed. */
export const NOTES_EXPANDED_KEY = 'notes.expanded'
