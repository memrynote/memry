import { getI18n } from 'react-i18next'
import { commands } from '../../../generated/bindings'
import { invokeBinary } from './ipc-binary'
import { extractErrorMessage } from './ipc-error'
import { createLogger } from './logger'

const log = createLogger('DropStage')

/** One chunk of a dropped file per IPC call; the shell appends them in order. */
export const CHUNK_BYTES = 4 * 1024 * 1024

interface Staged {
  id: string
  path: string
}

/**
 * The files of an OS drop: `File` objects with no path (WebKit on macOS, WebView2), or the
 * `file://` URIs the shell read off the native drag (WebKitGTK gives the page neither).
 */
export type DroppedFiles = { files: File[] } | { uris: string[] }

/** The file name a `file://` URI ends in, decoded. */
export function uriFileName(uri: string): string {
  try {
    return decodeURIComponent(new URL(uri).pathname.split('/').pop() ?? '')
  } catch {
    return ''
  }
}

export function droppedNames(dropped: DroppedFiles): string[] {
  return 'files' in dropped ? dropped.files.map((file) => file.name) : dropped.uris.map(uriFileName)
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

/** The shell's drop refusals (`stage_error` in `shell/drop_stage.rs`) the user can act on. */
const DROP_ERROR_KEYS: Record<string, string> = {
  drop_too_large: 'toast.drop.tooLarge',
  drop_too_many: 'toast.drop.tooMany',
  drop_too_much_held: 'toast.drop.tooMany',
  drop_not_a_file: 'toast.drop.notAFile',
  drop_not_dropped: 'toast.drop.unreadable'
}

/** What to tell the user when a drop could not be staged or imported. */
export function dropErrorMessage(error: unknown): string {
  const t = getI18n().getFixedT(null, 'common')
  const code =
    typeof error === 'object' && error !== null && 'code' in error ? String(error.code) : ''
  const key = DROP_ERROR_KEYS[code]
  return key ? t(key) : extractErrorMessage(error, t('phaseI.errors.failedToImportFiles'))
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
 * Runs `run` with the absolute paths of copies of the dropped files, and deletes the copies when
 * `run` settles. `File` objects are streamed into the shell; URIs are copied by the shell, which
 * takes only files of the OS drag it recorded. The drop is all or nothing: if one file cannot be
 * staged, the ones already staged are released and the error is thrown.
 */
export async function withStagedFiles<T>(
  dropped: DroppedFiles,
  run: (paths: string[]) => Promise<T>
): Promise<T> {
  const staged: Staged[] = []
  try {
    if ('uris' in dropped) staged.push(...(await commands.dropStageOsFiles(dropped.uris)))
    else for (const file of dropped.files) staged.push(await stage(file))
    return await run(staged.map((entry) => entry.path))
  } finally {
    await release(staged.map((entry) => entry.id))
  }
}
