import { NoteError, NoteErrorCode } from '../../../lib/errors'
import { getNoteById } from '../../../vault/notes'
import { AgentToolError } from '../errors'

const RETRY_DELAY_MS = 250

const isReadFailure = (error: unknown): error is NoteError =>
  error instanceof NoteError && error.code === NoteErrorCode.READ_FAILED

/**
 * A note update reads the file before it writes, so it never overwrites newer
 * text. A file another program holds for a moment (a sync client, a scanner)
 * fails that read once; read it again before giving up.
 */
export async function readNoteRetried(id: string): ReturnType<typeof getNoteById> {
  try {
    return await getNoteById(id)
  } catch (error) {
    if (!isReadFailure(error)) throw error
  }
  await new Promise((resolve) => setTimeout(resolve, RETRY_DELAY_MS))
  try {
    return await getNoteById(id)
  } catch (error) {
    if (!isReadFailure(error)) throw error
    // The errno only: the NoteError message carries the file path.
    const errno = (error.cause as NodeJS.ErrnoException | undefined)?.code ?? 'read error'
    throw new AgentToolError(
      'INTERNAL',
      `Note ${id} could not be read (${errno}). Another program may be holding the file; try again.`,
      { id }
    )
  }
}
