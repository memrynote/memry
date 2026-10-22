import { markdownPreviewText } from '@memry/shared/markdown-preview-text'
import { createLogger } from '../lib/logger'
import { getNoteById } from './notes'

const logger = createLogger('NoteBodyPreview')

/**
 * The plain text of a note's opening for a wiki-link card (#2845), read from
 * the note itself. A note that cannot be read, or whose content was left out
 * because it is too large, shows no preview rather than raw markdown.
 */
export async function readNoteBodyPreview(noteId: string): Promise<string | null> {
  try {
    const note = await getNoteById(noteId)
    if (!note || note.contentOmitted) return null
    return markdownPreviewText(note.content)
  } catch (error) {
    logger.warn('Could not read a note for a link card preview', { noteId, error })
    return null
  }
}
