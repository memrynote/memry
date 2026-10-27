import { commands } from '../../../generated/bindings'
import { invokeBinary } from './ipc-binary'
import { createLogger } from './logger'

const log = createLogger('DropStage')

/** One chunk of a dropped file per IPC call; the shell appends them in order. */
export const CHUNK_BYTES = 4 * 1024 * 1024

interface Staged {
  id: string
  path: string
}

/** Streams `file` into the shell's staging area and returns where it landed. */
async function stage(file: File): Promise<Staged> {
  const id = await commands.dropStageBegin(file.name, file.size)
  try {
    for (let offset = 0; offset < file.size; offset += CHUNK_BYTES) {
      const bytes = new Uint8Array(await file.slice(offset, offset + CHUNK_BYTES).arrayBuffer())
      await invokeBinary('drop_stage_chunk', bytes, { id, offset })
    }
    return { id, path: await commands.dropStageFinish(id) }
  } catch (error) {
    await release([id])
    throw error
  }
}

async function release(ids: string[]): Promise<void> {
  if (ids.length === 0) return
  try {
    await commands.dropStageRelease(ids)
  } catch (error) {
    // A copy that stays is swept at the next launch; the import itself already settled.
    log.warn('could not release staged drops', error)
  }
}

/**
 * Runs `run` with the absolute paths of copies of the dropped files (the webview hands a drop to
 * the page as `File` objects with no path), and deletes the copies when `run` settles. The
 * drop is all or nothing: if one file cannot be staged, the ones already staged are released and
 * the error is thrown.
 */
export async function withStagedFiles<T>(
  files: File[],
  run: (paths: string[]) => Promise<T>
): Promise<T> {
  const staged: Staged[] = []
  try {
    for (const file of files) staged.push(await stage(file))
    return await run(staged.map((entry) => entry.path))
  } finally {
    await release(staged.map((entry) => entry.id))
  }
}
