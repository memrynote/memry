import { unwrapIpcResult } from '@/lib/ipc-error'
import { notesService } from '@/services/notes-service'

const UNTITLED_VIEW = 'Untitled View'

/**
 * `Untitled View` in the note's folder, numbered past any folder already
 * there. Compared case-insensitively: on macOS and Windows `untitled view` is
 * the same directory.
 */
export function untitledViewFolderPath(
  notePath: string | undefined,
  existingFolders: readonly string[]
): string {
  const slash = notePath?.lastIndexOf('/') ?? -1
  const parent = notePath && slash > 0 ? `${notePath.slice(0, slash)}/` : ''
  const taken = new Set(existingFolders.map((path) => path.toLowerCase()))
  let path = `${parent}${UNTITLED_VIEW}`
  for (let n = 2; taken.has(path.toLowerCase()); n++) path = `${parent}${UNTITLED_VIEW} ${n}`
  return path
}

/**
 * Creates the folder a new view lists and returns its vault-relative path.
 * Throws main's error, or `failed` when it gave none.
 */
export async function createUntitledViewFolder(
  notePath: string | undefined,
  failed: string
): Promise<string> {
  const folders = await notesService.getFolders()
  const path = untitledViewFolderPath(
    notePath,
    folders.map((folder) => folder.path)
  )
  unwrapIpcResult(await notesService.createFolder(path), failed)
  return path
}
