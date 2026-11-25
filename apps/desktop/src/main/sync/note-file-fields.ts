import { readVaultFileSync } from '../lib/paths'
import { createLogger } from '../lib/logger'
import { getVaultRoot } from '../vault/notes-io'
import { caseTwinOffFileHeader } from '../vault/case-twin-shared-file'
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
    const vaultPath = getVaultRoot()
    // A case twin off its shared file (#5742): its header lives in its index
    // rows and its own version, never in the shared file, which holds the
    // other twin's header and body. Every field read here (tags, aliases, the
    // cover in `frontmatter`) comes from its own header, and no body is sent.
    const own = caseTwinOffFileHeader(vaultPath, note.path, note.id)
    const raw = own ? null : readVaultFileSync(vaultPath, note.path)
    if (!own && raw === null) throw new Error(`Note file is missing: ${note.path}`)
    const parsed = own ? { frontmatter: own, content: null } : parseNote(raw ?? '')
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
