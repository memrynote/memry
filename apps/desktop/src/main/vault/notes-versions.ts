/**
 * Note version history — snapshot creation, listing, retrieval, and restore.
 * Pulled from notes.ts during the Phase 3.1 split
 * (.claude/plans/tech-debt-remediation.md).
 *
 * @module vault/notes-versions
 */

import fs from 'fs/promises'
import { parseNote, calculateWordCount, generateContentHash } from './frontmatter'
import { syncNoteToCache } from './note-sync'
import { atomicWrite } from './file-ops'
import {
  getNoteCacheById,
  insertNoteSnapshot,
  getLatestSnapshot,
  snapshotExistsWithHash,
  getNoteSnapshots,
  getNoteSnapshotById,
  pruneOldSnapshots,
  ensureTagDefinitions
} from '@main/database/queries/notes'
import { SnapshotReasons, type SnapshotReason } from '@memry/db-schema/schema/notes-cache'
import { getDatabase, getIndexDatabase } from '../database'
import { NoteError, NoteErrorCode } from '../lib/errors'
import { generateNoteId } from '../lib/id'
import { NotesChannels } from '@memry/contracts/notes-api'
import { emitNoteEvent, toAbsolutePath } from './notes-io'
import type { Note } from './notes-crud'

// ============================================================================
// Snapshot Configuration
// ============================================================================

const MAX_SNAPSHOTS_PER_NOTE = 50
const MIN_SNAPSHOT_INTERVAL_MS = 5 * 60 * 1000
const SIGNIFICANT_WORD_CHANGE = 10

// ============================================================================
// Types
// ============================================================================

export interface SnapshotListItem {
  id: string
  noteId: string
  title: string
  wordCount: number
  reason: SnapshotReason
  createdAt: string
}

export interface SnapshotDetail extends SnapshotListItem {
  fileContent: string
}

// ============================================================================
// Snapshot Creation
// ============================================================================

export function createSnapshot(
  noteId: string,
  fileContent: string,
  title: string,
  reason: SnapshotReason,
  forceCreate = false
): SnapshotListItem | null {
  const db = getIndexDatabase()

  const contentHash = generateContentHash(fileContent)

  if (!forceCreate && snapshotExistsWithHash(db, noteId, contentHash)) {
    return null
  }

  if (reason === SnapshotReasons.AUTO || reason === SnapshotReasons.TIMER) {
    const latest = getLatestSnapshot(db, noteId)
    if (latest) {
      const latestTime = new Date(latest.createdAt).getTime()
      const now = Date.now()
      if (now - latestTime < MIN_SNAPSHOT_INTERVAL_MS) {
        return null
      }
    }
  }

  const parsed = parseNote(fileContent)
  const wordCount = calculateWordCount(parsed.content)

  const snapshot = insertNoteSnapshot(db, {
    id: generateNoteId(),
    noteId,
    fileContent,
    title,
    wordCount,
    contentHash,
    reason
  })

  pruneOldSnapshots(db, noteId, MAX_SNAPSHOTS_PER_NOTE)

  return {
    id: snapshot.id,
    noteId: snapshot.noteId,
    title: snapshot.title,
    wordCount: snapshot.wordCount,
    reason: snapshot.reason as SnapshotReason,
    createdAt: snapshot.createdAt
  }
}

export function maybeCreateSignificantSnapshot(
  noteId: string,
  currentFileContent: string,
  oldContent: string,
  newContent: string,
  title: string
): SnapshotListItem | null {
  const oldWordCount = calculateWordCount(oldContent)
  const newWordCount = calculateWordCount(newContent)
  const wordDiff = Math.abs(newWordCount - oldWordCount)

  if (wordDiff >= SIGNIFICANT_WORD_CHANGE) {
    try {
      return createSnapshot(noteId, currentFileContent, title, SnapshotReasons.SIGNIFICANT)
    } catch {
      return null
    }
  }

  return null
}

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

  const absolutePath = toAbsolutePath(cached.path)
  const currentFileContent = await fs.readFile(absolutePath, 'utf-8')
  const currentParsed = parseNote(currentFileContent)

  createSnapshot(
    cached.id,
    currentFileContent,
    currentParsed.frontmatter.title ?? cached.title,
    SnapshotReasons.SIGNIFICANT,
    true
  )

  const snapshotParsed = parseNote(snapshot.fileContent)

  await atomicWrite(absolutePath, snapshot.fileContent)

  const syncResult = syncNoteToCache(
    db,
    {
      id: cached.id,
      path: cached.path,
      fileContent: snapshot.fileContent,
      frontmatter: snapshotParsed.frontmatter,
      parsedContent: snapshotParsed.content
    },
    { isNew: false }
  )

  ensureTagDefinitions(dataDb, syncResult.tags)

  const restoredNote: Note = {
    id: cached.id,
    path: cached.path,
    title: snapshotParsed.frontmatter.title ?? cached.title,
    content: snapshotParsed.content,
    frontmatter: snapshotParsed.frontmatter,
    created: new Date(snapshotParsed.frontmatter.created),
    modified: new Date(),
    tags: syncResult.tags,
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

  return restoredNote
}
