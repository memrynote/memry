/**
 * `meta` keys shared across modules.
 *
 * They live here rather than being spelled out at each site because a key
 * written by one module and read by another is a contract, and a typo in one
 * half of it fails silently — the reader simply never finds the row.
 */

/** Set once a CRDT body pull has REACHED this note, whatever it found. */
export const crdtProbedKey = (noteId: string) => `crdt.probed.${noteId}`

/** Markdown to seed a locally-created note's editor with, until it lands. */
export const seedKey = (noteId: string) => `seed.${noteId}`
