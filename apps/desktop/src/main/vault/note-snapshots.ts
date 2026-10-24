/**
 * Snapshot creation, split from notes-versions so the CRDT feed can keep a
 * version without importing the restore path, which feeds the CRDT in turn.
 *
 * @module vault/note-snapshots
 */

import { parseNote, calculateWordCount, generateContentHash } from './frontmatter'
import {
  getNoteCacheById,
  insertNoteSnapshot,
  getLatestSnapshot,
  snapshotExistsWithHash,
  pruneOldSnapshots
} from '@main/database/queries/notes'
import { SnapshotReasons, type SnapshotReason } from '@memry/db-schema/schema/notes-cache'
import { getIndexDatabase } from '../database'
import { generateNoteId } from '../lib/id'
import { getVaultRoot } from './notes-io'
import { readVaultFile } from '../lib/paths'

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

/** A version of an open note's file as the app quits. False when there is nothing new to keep. */
export async function createCloseSnapshot(noteId: string): Promise<boolean> {
  const cached = getNoteCacheById(getIndexDatabase(), noteId)
  if (!cached) return false
  const fileContent = await readVaultFile(getVaultRoot(), cached.path)
  if (!fileContent) return false
  return createSnapshot(noteId, fileContent, cached.title, SnapshotReasons.CLOSE) !== null
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
