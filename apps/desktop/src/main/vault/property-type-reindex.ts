/**
 * Re-type the indexed rows of properties whose definition type changed.
 *
 * `note_properties.type` is resolved by `resolvePropertyType` when a note is
 * indexed, and the indexer skips notes it already knows. Without this pass a
 * property changed from `date` to `text` keeps its `date` rows, and the folder
 * view keeps offering a date picker for it, until each note is edited (#3080).
 * The file is re-read because the ladder needs the parsed value: an unquoted
 * YAML date stays `date` under a `text` definition (BBF-43), a quoted one does
 * not, and the index stores both as the same string.
 */

import { readFile } from 'fs/promises'
import path from 'path'
import {
  getNoteCacheById,
  getPropertyType,
  listNotePropertyRowsByName,
  setNotePropertyType
} from '@main/database/queries/notes'
import { createLogger } from '../lib/logger'
import { refuseOutsideVault } from '../lib/paths'
import { extractProperties, parseNote } from './frontmatter'
import { inferPropertyType } from './property-type'
import type { IndexDb } from '../database'

const logger = createLogger('PropertyTypeReindex')

/** Number of rows whose type changed. */
export async function retypeIndexedProperties(
  db: IndexDb,
  vaultPath: string,
  names: string[]
): Promise<number> {
  let retyped = 0
  for (const name of names) {
    for (const row of listNotePropertyRowsByName(db, name)) {
      const before = getNoteCacheById(db, row.noteId)
      if (!before) continue

      let raw: string
      try {
        await refuseOutsideVault(vaultPath, before.path)
        raw = await readFile(path.join(vaultPath, before.path), 'utf-8')
      } catch (error) {
        logger.warn('Skipping note, file unreadable', { noteId: row.noteId, error })
        continue
      }

      const properties = extractProperties(parseNote(raw, before.path).frontmatter)
      if (!Object.hasOwn(properties, name)) continue
      const type = getPropertyType(db, name, properties[name], inferPropertyType)
      if (type === row.type) continue

      // A projection that landed while the file was read already used the new definition.
      const after = getNoteCacheById(db, row.noteId)
      if (!after || after.path !== before.path || after.indexedAt !== before.indexedAt) continue

      setNotePropertyType(db, row.noteId, name, type)
      retyped++
    }
  }
  if (retyped > 0) logger.info('Re-typed indexed property rows', { names, retyped })
  return retyped
}
