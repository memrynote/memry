/**
 * A peer's frontmatter update of a case twin whose bytes are not on the file
 * it shares (#5561). The update goes to the twin's index rows, with the body
 * tags of its own doc, and the file stays as it is.
 *
 * @module vault/case-twin-off-file
 */

import * as Y from 'yjs'
import { getCrdtProvider } from '../sync/crdt-provider'
import { PendingSyncIntentError } from '../sync/pending-sync-intent-error'
import { COVER_FRONTMATTER_KEY, isCoverValue } from '@memry/shared/cover-image'
import { extractInlineTagsFromMarkdown } from '@memry/shared/inline-tags'
import { getNoteCacheById, type NoteTagSet } from '@main/database/queries/notes'
import {
  applyRemoteFrontmatter,
  type RemoteFrontmatterPatch
} from '../sync/item-handlers/note-handler-frontmatter'
import { getIndexDatabase } from '../database'
import { readVaultFileSync } from '../lib/paths'
import { createLogger } from '../lib/logger'
import { trackMainError } from '../telemetry/diagnostics'
import { sharesCaseTwinFile } from './case-twin-file'
import {
  convertBody,
  holdsOwnBytes,
  indexedHeader,
  sameStateVector,
  type PreparedBody
} from './case-twin-own-file'
import type { NoteFrontmatter } from './frontmatter'

const log = createLogger('CaseTwinFile')

/** A twin's doc as file body, by note id, for its next off-file tag update; taken once. */
const offFileBodies = new Map<string, PreparedBody>()
const convertingOffFile = new Set<string>()

/** A peer's frontmatter update of a case twin whose bytes are not on the file it shares. */
export interface OffFileTwinUpdate {
  /** The twin's header from its index rows, with the update applied. */
  frontmatter: NoteFrontmatter
  /** The cover ref of that header, for the twin's index row. */
  cover: string | null
  /**
   * Its tag rows when the update changes its tags: the header's, and the body
   * tags of its own doc, as the body on the file is the other twin's.
   */
  tags?: NoteTagSet
}

/**
 * A peer's frontmatter-only update of note `noteId` (#5561). While case twins
 * share its file and the bytes there are not its own, patching them puts the
 * other twin's body under this note's header, and that twin's aliases and
 * body tags into this note's index rows. The file stays as it is, and the
 * update goes to the header the note's index rows hold, which a split writes
 * to its own file (`ownFile`). Returns that update, or null when the file
 * takes it in place: the file is not shared, or holds the note's own bytes.
 * An update of its tags throws `PendingSyncIntentError` until its doc's body
 * is converted, for the body tags; the pull retries it.
 */
export function updateCaseTwinOffFile(
  vaultPath: string,
  relativePath: string,
  noteId: string,
  patch: RemoteFrontmatterPatch
): OffFileTwinUpdate | null {
  if (!sharesCaseTwinFile(vaultPath, relativePath)) return null
  const indexDb = getIndexDatabase()
  const cached = getNoteCacheById(indexDb, noteId)
  const raw = readVaultFileSync(vaultPath, relativePath)
  if (raw !== null && cached && holdsOwnBytes(raw, cached)) return null
  const cachedCover = cached?.cover
  const cover = isCoverValue(cachedCover) ? cachedCover : null
  const frontmatter = applyRemoteFrontmatter(
    indexedHeader(indexDb, noteId, patch.title, cover),
    patch
  )
  const patchedCover = frontmatter[COVER_FRONTMATTER_KEY]
  const tags = patch.tags
  return {
    frontmatter,
    cover: isCoverValue(patchedCover) ? patchedCover : null,
    tags: tags && {
      header: tags,
      inline: extractInlineTagsFromMarkdown(takeOffFileBody(noteId).body?.markdown ?? '')
    }
  }
}

/**
 * Twin `noteId`'s own body, converted from its doc for this call. Throws
 * `PendingSyncIntentError` while it converts, and when the live doc changed
 * since; a doc that cannot convert is logged and tried again on the retry.
 */
function takeOffFileBody(noteId: string): PreparedBody {
  const prepared = offFileBodies.get(noteId)
  offFileBodies.delete(noteId)
  const live = getCrdtProvider().getDoc(noteId)
  if (prepared && (!live || sameStateVector(Y.encodeStateVector(live), prepared.converted))) {
    return prepared
  }
  if (!convertingOffFile.has(noteId)) {
    convertingOffFile.add(noteId)
    convertBody(noteId)
      .then(
        (converted) => offFileBodies.set(noteId, converted),
        (error: unknown) => {
          log.error('Could not read the own body of a case twin off its shared file', {
            noteId,
            error
          })
          trackMainError('notes', 'case_twin_off_file_body', error)
        }
      )
      .finally(() => convertingOffFile.delete(noteId))
  }
  throw new PendingSyncIntentError('note', noteId)
}
