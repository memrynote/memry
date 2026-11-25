/**
 * A case twin's own file (#5297, #5561): its doc's body, converted to
 * markdown, under a header rebuilt from its index rows. The file the twins
 * share holds one twin's bytes, so a twin's own file never comes from it
 * unless those bytes are the twin's own (`holdsOwnBytes`).
 *
 * @module vault/case-twin-own-file
 */

import * as Y from 'yjs'
import { getCrdtProvider } from '../sync/crdt-provider'
import { readyWritebackConverter } from '../sync/converter-worker-bridge'
import type { NoteBody } from '../sync/writing-markdown'
import { CRDT_FRAGMENT_NAME } from '@memry/contracts/ipc-crdt'
import { isCoverValue } from '@memry/shared/cover-image'
import { toWritingFrontmatterValue, WRITING_FRONTMATTER_KEY } from '@memry/shared'
import {
  getAliasesForNotes,
  getNoteFileProperties,
  getNoteHeaderTags,
  getNoteSnapshots
} from '@main/database/queries/notes'
import { getNoteMetadataById } from '@memry/storage-data'
import { applyRemoteFrontmatter } from '../sync/item-handlers/note-handler-frontmatter'
import { getDatabase, type getIndexDatabase } from '../database'
import { NoteError, NoteErrorCode } from '../lib/errors'
import { generateContentHash, parseNote, serializeNote, type NoteFrontmatter } from './frontmatter'

export interface PreparedBody {
  /** Null for a doc with no body: the file keeps the header alone. */
  body: NoteBody | null
  /** The doc's state vector when converted. */
  converted: Uint8Array
}

/** A twin's own file: its bytes, and the header and body they hold. */
export interface OwnTwinFile {
  content: string
  frontmatter: NoteFrontmatter
  markdown: string
}

/** Note `noteId`'s doc as file body. Throws `NoteError` when it cannot be loaded or written as markdown. */
export async function convertBody(noteId: string): Promise<PreparedBody> {
  const provider = getCrdtProvider()
  const live = provider.getDoc(noteId)
  try {
    const doc = live ?? (await provider.open(noteId, undefined, { skipSeed: true }))
    try {
      if (doc.getXmlFragment(CRDT_FRAGMENT_NAME).length === 0) {
        return { body: null, converted: Y.encodeStateVector(doc) }
      }
      const convert = await readyWritebackConverter()
      const converted = Y.encodeStateVector(doc)
      const notePath = getNoteMetadataById(getDatabase(), noteId)?.path ?? ''
      // No file to restore spellings from: the bytes there may be the other twin's.
      const conversion = await convert(doc, notePath, async () => null)
      if (conversion.kind === 'unrepresentable' || conversion.body === null) {
        throw new Error(`The doc cannot be written as markdown (${conversion.kind})`)
      }
      return { body: conversion.body, converted }
    } finally {
      if (!live) await provider.closeIfInactive(noteId)
    }
  } catch (error) {
    throw new NoteError(
      'A note on this shared file could not be written; nothing was changed',
      NoteErrorCode.WRITE_FAILED,
      noteId,
      { cause: error }
    )
  }
}

/** Whether `raw` is the bytes a note's index row records as its own. */
export function holdsOwnBytes(
  raw: string,
  cached: { contentHash?: string | null; pendingWriteHash?: string | null }
): boolean {
  const onDisk = generateContentHash(raw)
  return onDisk === cached.contentHash || onDisk === cached.pendingWriteHash
}

/**
 * A note's header as its index rows hold it, which a split writes to its own
 * file. A property of `file`'s header that stores as the row does keeps its
 * YAML type (`getNoteFileProperties`).
 */
export function indexedHeader(
  indexDb: ReturnType<typeof getIndexDatabase>,
  noteId: string,
  title: string,
  cover: string | null,
  file?: NoteFrontmatter
): NoteFrontmatter {
  return applyRemoteFrontmatter(
    {},
    {
      tags: getNoteHeaderTags(indexDb, noteId),
      properties: getNoteFileProperties(indexDb, noteId, file),
      aliases: getAliasesForNotes(indexDb, [noteId]).get(noteId) ?? [],
      ...(cover !== null ? { cover: { ref: cover } } : {}),
      title
    }
  )
}

/**
 * The header of a note's own last file, when one of its versions holds the
 * bytes its baseline names. The shared file's header may be the other twin's,
 * so it never stands in.
 */
function ownLastHeader(
  indexDb: ReturnType<typeof getIndexDatabase>,
  noteId: string,
  baseline: { contentHash?: string | null; pendingWriteHash?: string | null }
): NoteFrontmatter | undefined {
  const hashes = new Set([baseline.contentHash, baseline.pendingWriteHash])
  const version = getNoteSnapshots(indexDb, noteId).find((snapshot) =>
    hashes.has(snapshot.contentHash)
  )
  return version ? parseNote(version.fileContent).frontmatter : undefined
}

type OwnBaseline = {
  cover?: string | null
  contentHash?: string | null
  pendingWriteHash?: string | null
}

/**
 * A note's own header: rebuilt from its index rows, with the YAML types of its
 * own last header (`ownLastHeader`). The header a split writes, and the one a
 * push of the note sends.
 */
export function ownHeader(
  indexDb: ReturnType<typeof getIndexDatabase>,
  noteId: string,
  title: string,
  cached: OwnBaseline
): NoteFrontmatter {
  const cover = isCoverValue(cached.cover) ? cached.cover : null
  return indexedHeader(indexDb, noteId, title, cover, ownLastHeader(indexDb, noteId, cached))
}

/** A note's own file: its prepared doc body under its own header (`ownHeader`). */
export function ownFile(
  indexDb: ReturnType<typeof getIndexDatabase>,
  noteId: string,
  title: string,
  cached: OwnBaseline,
  prepared: PreparedBody
): OwnTwinFile & { cover: string | null } {
  const cover = isCoverValue(cached.cover) ? cached.cover : null
  const header = ownHeader(indexDb, noteId, title, cached)
  const writing = prepared.body ? toWritingFrontmatterValue(prepared.body.writing) : undefined
  if (writing) header[WRITING_FRONTMATTER_KEY] = writing
  const markdown = prepared.body?.markdown ?? ''
  const serialized = serializeNote(header, markdown)
  const content = serialized.endsWith('\n') ? serialized : `${serialized}\n`
  return { content, frontmatter: header, markdown, cover }
}

export function sameStateVector(a: Uint8Array, b: Uint8Array): boolean {
  return a.length === b.length && a.every((byte, i) => byte === b[i])
}
