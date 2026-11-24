import fs from 'node:fs/promises'
import path from 'node:path'
import { noteMetadata } from '@memry/db-schema/data-schema'
import { foldNotePath, listNoteMetadataByFoldedPath } from '@memry/storage-data'
import type { DataDb } from './database.ts'
import { errorCode } from './errno.ts'

interface NoteRef {
  id: string
  path: string
}

async function fileIdentity(vaultPath: string, relativePath: string): Promise<string | null> {
  try {
    const stats = await fs.stat(path.join(vaultPath, relativePath), { bigint: true })
    return `${stats.dev}:${stats.ino}`
  } catch (error) {
    const code = errorCode(error)
    if (code === 'ENOENT' || code === 'ENOTDIR') return null
    throw error
  }
}

/**
 * The other notes whose file is `note`'s file. On a case-insensitive disk
 * (macOS, Windows) two rows whose paths differ only in case, which sync
 * delivers from a case-sensitive peer (#5263), name one file, so a delete,
 * rename or move of that file takes it from the other note too (#5650).
 * The fold finds candidates and the disk proves them, as desktop's
 * `sharesCaseTwinFile` does (apps/desktop/src/main/vault/case-twin-file.ts).
 */
export async function caseTwinsOnFile(
  db: DataDb,
  vaultPath: string,
  note: NoteRef
): Promise<NoteRef[]> {
  const candidates = listNoteMetadataByFoldedPath(db, note.path).filter((row) => row.id !== note.id)
  if (candidates.length === 0) return []
  const file = await fileIdentity(vaultPath, note.path)
  if (file === null) return []
  const twins: NoteRef[] = []
  for (const row of candidates) {
    if ((await fileIdentity(vaultPath, row.path)) === file) twins.push(row)
  }
  return twins
}

/** A note under `folder`, in any case, whose file case twins share. */
export async function caseTwinUnderFolder(
  db: DataDb,
  vaultPath: string,
  folder: string
): Promise<NoteRef | undefined> {
  const prefix = foldNotePath(`${folder}/`)
  const rows = db.select({ id: noteMetadata.id, path: noteMetadata.path }).from(noteMetadata).all()
  for (const row of rows) {
    if (!foldNotePath(row.path).startsWith(prefix)) continue
    if ((await caseTwinsOnFile(db, vaultPath, row)).length > 0) return row
  }
  return undefined
}

/** Throws when a rename or move of `note`'s file would take it from a case twin. */
export async function assertNoteFileUnshared(
  db: DataDb,
  vaultPath: string,
  note: NoteRef,
  verb: 'rename' | 'move'
): Promise<void> {
  const [twin] = await caseTwinsOnFile(db, vaultPath, note)
  if (!twin) return
  throw new Error(
    `Refusing to ${verb} note "${note.path}": note "${twin.path}" shares its file on this case-insensitive disk, and the ${verb} would take the file from it. Do it in the desktop app, which keeps a file for each note.`
  )
}
