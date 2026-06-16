/**
 * Assemble a per-note import plan from parsed ENEX data.
 *
 * Each .enex file maps to exactly ONE Evernote notebook. The notebook name is
 * the .enex file's basename (minus the ".enex" extension), supplied by the
 * desktop importer. The caller is responsible for sanitizing the name for the
 * filesystem.
 */

import type { EnexNote } from './types.ts'

export interface NoteImportPlan {
  note: EnexNote
  /** Vault folder to store the note in. */
  folder: string
}

/**
 * Build import plans for all notes in a single .enex file.
 *
 * @param notes      - Parsed notes from {@link parseEnex}.
 * @param notebook   - Sanitized notebook name (basename of the .enex file).
 *                     Pass an empty string to store under root `Evernote/`.
 */
export function mapNotes(notes: EnexNote[], notebook: string): NoteImportPlan[] {
  const folder = notebook ? `Evernote/${notebook}` : 'Evernote'
  return notes.map((note) => ({ note, folder }))
}
