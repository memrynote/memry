/**
 * A frontmatter update of a case twin whose bytes are not on the file it
 * shares, from a peer (#5561) or a local edit (#5742). The update goes to the
 * twin's index rows, with the body tags of its own doc, and the file stays as
 * it is.
 *
 * @module vault/case-twin-off-file
 */

import * as Y from 'yjs'
import { getCrdtProvider } from '../sync/crdt-provider'
import { PendingSyncIntentError } from '../sync/pending-sync-intent-error'
import { COVER_FRONTMATTER_KEY, isCoverValue } from '@memry/shared/cover-image'
import { extractInlineTagsFromMarkdown } from '@memry/shared/inline-tags'
import {
  getNoteCacheById,
  getNoteHeaderTags,
  getNoteTags,
  type NoteTagSet
} from '@main/database/queries/notes'
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
  ownFile,
  sameStateVector,
  type OwnTwinFile,
  type PreparedBody
} from './case-twin-own-file'
import type { NoteFrontmatter } from './frontmatter'

const log = createLogger('CaseTwinFile')

/**
 * A twin's doc as file body, by note id, for its next off-file tag update, or
 * null when the doc could not be converted; taken once.
 */
const offFileBodies = new Map<string, PreparedBody | null>()
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
 * is converted, for the body tags; the pull retries it. A doc that cannot be
 * converted leaves its body tag rows as the index holds them.
 */
export function updateCaseTwinOffFile(
  vaultPath: string,
  relativePath: string,
  noteId: string,
  patch: RemoteFrontmatterPatch
): OffFileTwinUpdate | null {
  if (!isCaseTwinOffFile(vaultPath, relativePath, noteId)) return null
  const indexDb = getIndexDatabase()
  const cachedCover = getNoteCacheById(indexDb, noteId)?.cover
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
    tags: tags && { header: tags, inline: ownInlineTags(indexDb, noteId) }
  }
}

/**
 * Whether note `noteId` shares its file with a case twin and the bytes there
 * are not its own: patching them would put the other twin's body under this
 * note's header.
 */
export function isCaseTwinOffFile(
  vaultPath: string,
  relativePath: string,
  noteId: string
): boolean {
  if (!sharesCaseTwinFile(vaultPath, relativePath)) return false
  const cached = getNoteCacheById(getIndexDatabase(), noteId)
  const raw = readVaultFileSync(vaultPath, relativePath)
  return raw === null || !cached || !holdsOwnBytes(raw, cached)
}

/**
 * Note `noteId`'s own file, for a local header edit (#5742): its doc's body
 * under the header its index rows hold. Null when its file takes the edit in
 * place (`isCaseTwinOffFile`). The edit goes to the note's index rows, which
 * a split writes to its own file, and the shared file stays as it is. Throws
 * `NoteError` when its doc cannot be loaded or written as markdown.
 */
export async function caseTwinOwnFile(
  vaultPath: string,
  relativePath: string,
  noteId: string
): Promise<OwnTwinFile | null> {
  if (!isCaseTwinOffFile(vaultPath, relativePath, noteId)) return null
  const indexDb = getIndexDatabase()
  const cached = getNoteCacheById(indexDb, noteId)
  if (!cached) return null
  return ownFile(indexDb, noteId, cached.title, cached, await convertBody(noteId))
}

/**
 * Twin `noteId`'s body tags, from its own doc. Holding the update while the
 * doc could not convert held it for good (VERIFY-5618): the tag rows of its
 * body stay as indexed instead, and a body tag also in its header is one
 * header row there, so the update drops it with the header's.
 */
function ownInlineTags(indexDb: ReturnType<typeof getIndexDatabase>, noteId: string): string[] {
  const own = takeOffFileBody(noteId)
  if (own !== null) return extractInlineTagsFromMarkdown(own.body?.markdown ?? '')
  log.warn("A case twin's doc cannot be converted; its body tags stay as indexed", { noteId })
  const header = new Set(getNoteHeaderTags(indexDb, noteId))
  return getNoteTags(indexDb, noteId).filter((tag) => !header.has(tag))
}

/**
 * Twin `noteId`'s own body, converted from its doc for this call, or null when
 * the doc could not be converted. Throws `PendingSyncIntentError` while it
 * converts, and when the live doc changed since.
 */
function takeOffFileBody(noteId: string): PreparedBody | null {
  const prepared = offFileBodies.get(noteId)
  offFileBodies.delete(noteId)
  if (prepared === null) return null
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
          offFileBodies.set(noteId, null)
        }
      )
      .finally(() => convertingOffFile.delete(noteId))
  }
  throw new PendingSyncIntentError('note', noteId)
}
