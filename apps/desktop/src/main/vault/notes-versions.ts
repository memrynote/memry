/**
 * Note version history — snapshot creation, listing, retrieval, and restore.
 * Pulled from notes.ts during the Phase 3.1 split
 * (.claude/plans/tech-debt-remediation.md).
 *
 * @module vault/notes-versions
 */

import { parseNote } from './frontmatter'
import { writingFrontmatterOf } from '@memry/shared/writing-tools/markdown'
import { syncNoteToCache } from './note-sync'
import { atomicWrite } from './file-ops'
import {
  getNoteCacheById,
  getNoteSnapshots,
  getNoteSnapshotById,
  ensureTagDefinitions
} from '@main/database/queries/notes'
import { SnapshotReasons, type SnapshotReason } from '@memry/db-schema/schema/notes-cache'
import { getDatabase, getIndexDatabase } from '../database'
import { replaceNoteTagsInCrdt } from '../sync/crdt-feed'
import { feedExternalEditToCrdt } from '../sync/crdt-external-feed'
import { NoteError, NoteErrorCode } from '../lib/errors'
import { NotesChannels } from '@memry/contracts/notes-api'
import { emitNoteEvent, getVaultRoot, toAbsolutePath } from './notes-io'
import { readVaultFile } from '../lib/paths'
import { createSnapshot, type SnapshotListItem } from './note-snapshots'
import type { Note } from './notes-crud'
import { assertNoteWritable } from '../vault-locks/registry'

export interface SnapshotDetail extends SnapshotListItem {
  fileContent: string
}

export {
  createCloseSnapshot,
  createSnapshot,
  maybeCreateSignificantSnapshot,
  type SnapshotListItem
} from './note-snapshots'

// ============================================================================
// Version History
// ============================================================================

export function getVersionHistory(noteId: string, limit = 50): SnapshotListItem[] {
  const db = getIndexDatabase()
  const snapshots = getNoteSnapshots(db, noteId, limit)

  return snapshots.map((s) => ({
    id: s.id,
    noteId: s.noteId,
    title: s.title,
    wordCount: s.wordCount,
    reason: s.reason as SnapshotReason,
    createdAt: s.createdAt
  }))
}

export function getVersion(snapshotId: string): SnapshotDetail | null {
  const db = getIndexDatabase()
  const snapshot = getNoteSnapshotById(db, snapshotId)

  if (!snapshot) {
    return null
  }

  return {
    id: snapshot.id,
    noteId: snapshot.noteId,
    title: snapshot.title,
    fileContent: snapshot.fileContent,
    wordCount: snapshot.wordCount,
    reason: snapshot.reason as SnapshotReason,
    createdAt: snapshot.createdAt
  }
}

export async function restoreVersion(snapshotId: string): Promise<Note> {
  const db = getIndexDatabase()
  const dataDb = getDatabase()
  const snapshot = getNoteSnapshotById(db, snapshotId)

  if (!snapshot) {
    throw new NoteError(`Snapshot not found: ${snapshotId}`, NoteErrorCode.NOT_FOUND, snapshotId)
  }

  const cached = getNoteCacheById(db, snapshot.noteId)
  if (!cached) {
    throw new NoteError(
      `Note not found: ${snapshot.noteId}`,
      NoteErrorCode.NOT_FOUND,
      snapshot.noteId
    )
  }

  assertNoteWritable(cached.id, cached.path)

  const absolutePath = toAbsolutePath(cached.path)
  const currentFileContent = await readVaultFile(getVaultRoot(), cached.path)
  if (currentFileContent === null) throw new Error(`Note file is missing: ${absolutePath}`)

  createSnapshot(cached.id, currentFileContent, cached.title, SnapshotReasons.SIGNIFICANT, true)

  const snapshotParsed = parseNote(snapshot.fileContent)
  const now = new Date()

  await atomicWrite(absolutePath, snapshot.fileContent)

  const syncResult = syncNoteToCache(
    db,
    {
      id: cached.id,
      path: cached.path,
      fileContent: snapshot.fileContent,
      frontmatter: snapshotParsed.frontmatter,
      parsedContent: snapshotParsed.content,
      title: cached.title,
      createdAt: cached.createdAt,
      modifiedAt: now.toISOString(),
      localOnly: cached.localOnly ?? false,
      emoji: cached.emoji ?? null
    },
    { isNew: false }
  )

  ensureTagDefinitions(dataDb, syncResult.tags)

  const restoredNote: Note = {
    id: cached.id,
    path: cached.path,
    title: cached.title,
    content: snapshotParsed.content,
    frontmatter: snapshotParsed.frontmatter,
    created: new Date(cached.createdAt),
    modified: now,
    tags: syncResult.tags,
    headerTags: syncResult.headerTags,
    aliases: snapshotParsed.frontmatter.aliases ?? [],
    wordCount: syncResult.wordCount,
    properties: syncResult.properties,
    emoji: syncResult.emoji
  }

  emitNoteEvent(NotesChannels.events.UPDATED, {
    id: cached.id,
    changes: restoredNote,
    source: 'internal'
  })

  // The file is not the note's body while an editor holds it: the Y.Doc is.
  // `syncNoteToCache` above refreshes the index row's content hash before the
  // watcher reaches the file, so the watcher dedupes and never feeds the CRDT
  // either (`vault/watcher.ts`) — without these two lines a restore of an open
  // note shows nothing and the next write-back rewrites the file from the
  // unrestored Y.Doc. Same closing step as `vault/append-blocks.ts`.
  await feedExternalEditToCrdt(
    cached.id,
    snapshotParsed.content,
    writingFrontmatterOf(snapshotParsed.frontmatter)
  )
  replaceNoteTagsInCrdt(cached.id, syncResult.headerTags)

  return restoredNote
}
