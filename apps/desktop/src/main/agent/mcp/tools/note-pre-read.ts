import { NoteError, NoteErrorCode } from '../../../lib/errors'
import { getNoteById } from '../../../vault/notes'
import { AgentToolError } from '../errors'

const PRE_READ_RETRY_DELAY_MS = 250

const isReadFailure = (error: unknown): error is NoteError =>
  error instanceof NoteError && error.code === NoteErrorCode.READ_FAILED

/**
 * An agent update merges into the note as it is on disk, so it never writes
 * without this read. A file another program holds for a moment (a sync client,
 * a scanner) fails the read once; read it again before giving up.
 */
export async function readNoteBeforeUpdate(id: string): ReturnType<typeof getNoteById> {
  try {
    return await getNoteById(id)
  } catch (error) {
    if (!isReadFailure(error)) throw error
  }
  await new Promise((resolve) => setTimeout(resolve, PRE_READ_RETRY_DELAY_MS))
  try {
    return await getNoteById(id)
  } catch (error) {
    if (!isReadFailure(error)) throw error
    // The errno only: the NoteError message carries the file path.
    const errno = (error.cause as NodeJS.ErrnoException | undefined)?.code ?? 'read error'
    throw new AgentToolError(
      'INTERNAL',
      `Note ${id} could not be read before the update (${errno}), so nothing was written. ` +
        'Another program may be holding the file; try again.',
      { id }
    )
  }
}
