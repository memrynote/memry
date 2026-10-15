import { readVaultFileSync } from '../lib/paths'
import { createLogger } from '../lib/logger'
import { getVaultRoot } from '../vault/notes'
import { extractAliases, parseNote, type NoteFrontmatter } from '../vault/frontmatter'

const log = createLogger('NoteFileFields')

export interface NoteFileFields {
  content: string | null
  tags: string[]
  /**
   * Always an array when the file was read, `[]` included, so a peer clears a
   * removed list. Absent when it was not: absent tells a peer to keep its own
   * (chapter 13 §13.7.1).
   */
  aliases?: string[]
  frontmatter: NoteFrontmatter | null
}

export function readNoteFileFields(
  note: { id: string; path: string; title: string },
  operation: string
): NoteFileFields {
  try {
    const raw = readVaultFileSync(getVaultRoot(), note.path)
    if (raw === null) throw new Error(`Note file is missing: ${note.path}`)
    const parsed = parseNote(raw)
    return {
      content: operation === 'create' ? parsed.content : null,
      tags: parsed.frontmatter.tags ?? [],
      aliases: extractAliases(parsed.frontmatter, note.title),
      frontmatter: parsed.frontmatter
    }
  } catch (error) {
    log.warn('Could not read note file for a sync payload', { noteId: note.id, error })
    return { content: null, tags: [], frontmatter: null }
  }
}
