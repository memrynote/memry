/**
 * AI-Powered Filing Suggestions
 *
 * Provides smart filing suggestions using local embeddings (all-MiniLM-L6-v2)
 * and sqlite-vec for efficient vector similarity search.
 * Learns from filing history to improve suggestions over time.
 *
 * @module inbox/suggestions
 */

import { BrowserWindow } from 'electron'
import { createLogger } from '../lib/logger'
import { getDatabase, getIndexDatabase, getRawIndexDatabase } from '../database'
import { inboxItems, filingHistory, suggestionFeedback } from '@memry/db-schema/schema/inbox'
import { noteCache } from '@memry/db-schema/schema/notes-cache'
import { eq, desc, sql } from 'drizzle-orm'
import { generateId } from '../lib/id'
import { getSetting } from '@main/database/queries/settings'
import { listNotesFromCache } from '@main/database/queries/notes'
import { getNoteById } from '../vault/notes'
import { getConfig } from '../vault'
import { SettingsChannels } from '@memry/contracts/ipc-channels'
import {
  generateEmbedding as generateLocalEmbedding,
  isModelLoaded,
  initEmbeddingModel
} from '../lib/embeddings'
import type { FilingSuggestion, SuggestedNote } from '@memry/contracts/inbox-api'

const log = createLogger('Inbox:Suggestions')

// ============================================================================
// Types
// ============================================================================

interface SimilarNote {
  noteId: string
  notePath: string
  noteTitle: string
  score: number
  snippet: string
  emoji: string | null
}

interface FilingPattern {
  destination: string
  action: string
  count: number
  tags: string[]
}

interface VecSearchResult {
  note_id: string
  distance: number
}

// ============================================================================
// Constants
// ============================================================================

const AI_SETTINGS_KEY = 'ai.enabled'

/** Maximum cosine distance to include in suggestions (lower = more similar) */
const MAX_DISTANCE_THRESHOLD = 1.0

/** Maximum number of folder suggestions to return */
const MAX_SUGGESTIONS = 3

/** Maximum number of note-level suggestions to return */
const MAX_NOTE_SUGGESTIONS = 3

/** Minimum content length to generate embedding */
const MIN_CONTENT_LENGTH = 10

// ============================================================================
// Helper Functions
// ============================================================================

/**
 * Get data database, throwing if not available
 */
function requireDatabase() {
  try {
    return getDatabase()
  } catch {
    throw new Error('No vault is open. Please open a vault first.')
  }
}

/**
 * Get index database, throwing if not available
 */
function requireIndexDatabase() {
  try {
    return getIndexDatabase()
  } catch {
    throw new Error('No vault is open. Please open a vault first.')
  }
}

/**
 * Get raw SQLite database for vec0 queries
 */
function requireRawIndexDatabase() {
  try {
    return getRawIndexDatabase()
  } catch {
    throw new Error('No vault is open. Please open a vault first.')
  }
}

/**
 * Check if AI is enabled
 */
function isAIEnabled(): boolean {
  try {
    const db = getDatabase()
    const enabled = getSetting(db, AI_SETTINGS_KEY)
    return enabled !== 'false' // Default to true
  } catch {
    return false
  }
}

/**
 * Emit progress event to all windows
 */
function emitProgress(current: number, total: number, phase: string): void {
  BrowserWindow.getAllWindows().forEach((win) => {
    win.webContents.send(SettingsChannels.events.EMBEDDING_PROGRESS, {
      current,
      total,
      phase
    })
  })
}

// ============================================================================
// Vector Storage (sqlite-vec)
// ============================================================================

/**
 * Store embedding for a note in vec_notes virtual table
 */
export function storeNoteEmbedding(noteId: string, embedding: Float32Array): void {
  const rawDb = requireRawIndexDatabase()

  // Delete existing embedding if any
  rawDb.prepare('DELETE FROM vec_notes WHERE note_id = ?').run(noteId)

  // Insert new embedding
  rawDb.prepare('INSERT INTO vec_notes (note_id, embedding) VALUES (?, ?)').run(noteId, embedding)
}

/**
 * Delete embedding for a note
 */
export function deleteNoteEmbedding(noteId: string): void {
  try {
    const rawDb = requireRawIndexDatabase()
    rawDb.prepare('DELETE FROM vec_notes WHERE note_id = ?').run(noteId)
  } catch {
    // Ignore errors - embedding might not exist
  }
}

/**
 * Check if note has an embedding
 */
export function hasEmbedding(noteId: string): boolean {
  try {
    const rawDb = requireRawIndexDatabase()
    const result = rawDb
      .prepare('SELECT 1 FROM vec_notes WHERE note_id = ? LIMIT 1')
      .get(noteId) as { '1': number } | undefined
    return result !== undefined
  } catch {
    return false
  }
}

/**
 * Get count of stored embeddings
 */
export function getEmbeddingCount(): number {
  try {
    const rawDb = requireRawIndexDatabase()
    const result = rawDb.prepare('SELECT COUNT(*) as count FROM vec_notes').get() as {
      count: number
    }
    return result?.count || 0
  } catch {
    return 0
  }
}

// ============================================================================
// Note Embedding Management
// ============================================================================

/**
 * Compute and store embedding for a single note
 */
export async function updateNoteEmbedding(noteId: string): Promise<boolean> {
  // Check if AI is enabled
  if (!isAIEnabled()) {
    return false
  }

  try {
    const note = await getNoteById(noteId)
    if (!note) {
      log.debug(`Note not found: ${noteId}`)
      return false
    }

    // Skip if content is too short
    if (!note.content || note.content.length < MIN_CONTENT_LENGTH) {
      return false
    }

    // Generate embedding using local model
    const embedding = await generateLocalEmbedding(note.content)
    if (!embedding) {
      log.debug(`Failed to generate embedding for: ${noteId}`)
      return false
    }

    // Store in vec_notes
    storeNoteEmbedding(noteId, embedding)
    return true
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error'
    log.error(`Failed to update embedding for ${noteId}:`, message)
    return false
  }
}

/**
 * Reindex all note embeddings
 * Called from settings when user clicks "Re-index"
 */
export async function reindexAllEmbeddings(): Promise<{
  success: boolean
  computed: number
  skipped: number
  error?: string
}> {
  if (!isAIEnabled()) {
    return { success: false, computed: 0, skipped: 0, error: 'AI is disabled' }
  }

  // Ensure model is loaded
  if (!isModelLoaded()) {
    const loaded = await initEmbeddingModel()
    if (!loaded) {
      return { success: false, computed: 0, skipped: 0, error: 'Failed to load embedding model' }
    }
  }

  try {
    const indexDb = requireIndexDatabase()
    const rawDb = requireRawIndexDatabase()
    const notes = listNotesFromCache(indexDb, { limit: 10000 })

    let computed = 0
    let skipped = 0
    const total = notes.length

    emitProgress(0, total, 'scanning')

    // Clear existing embeddings for clean reindex
    rawDb.prepare('DELETE FROM vec_notes').run()

    emitProgress(0, total, 'embedding')

    for (let i = 0; i < notes.length; i++) {
      const noteItem = notes[i]

      // Get full note content
      const note = await getNoteById(noteItem.id)
      if (!note || !note.content || note.content.length < MIN_CONTENT_LENGTH) {
        skipped++
        continue
      }

      // Generate embedding
      const embedding = await generateLocalEmbedding(note.content)
      if (!embedding) {
        skipped++
        continue
      }

      // Store embedding
      storeNoteEmbedding(noteItem.id, embedding)
      computed++

      // Emit progress every 5 notes
      if ((computed + skipped) % 5 === 0) {
        emitProgress(computed + skipped, total, 'embedding')
      }
    }

    emitProgress(total, total, 'complete')
    log.info(`Reindex complete: ${computed} computed, ${skipped} skipped`)

    return { success: true, computed, skipped }
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error'
    log.error('Reindex failed:', message)
    return { success: false, computed: 0, skipped: 0, error: message }
  }
}

// ============================================================================
// Similarity Search (sqlite-vec)
// ============================================================================

/**
 * Find notes similar to the given content using sqlite-vec KNN search
 */
async function findSimilarNotes(content: string, limit: number = 5): Promise<SimilarNote[]> {
  // Generate embedding for the content
  const embedding = await generateLocalEmbedding(content)
  if (!embedding) {
    return []
  }

  try {
    const rawDb = requireRawIndexDatabase()
    const indexDb = requireIndexDatabase()

    // Use sqlite-vec KNN search with cosine distance
    // Lower distance = more similar (cosine distance ranges from 0 to 2)
    const results = rawDb
      .prepare(
        `
      SELECT note_id, distance
      FROM vec_notes
      WHERE embedding MATCH ?
        AND k = ?
      ORDER BY distance
    `
      )
      .all(embedding, limit) as VecSearchResult[]

    if (results.length === 0) {
      log.debug('No similar notes found')
      return []
    }

    // Convert to SimilarNote format with note info
    const similarities: SimilarNote[] = []

    for (const row of results) {
      // Skip if distance is too high (not similar enough)
      if (row.distance > MAX_DISTANCE_THRESHOLD) continue

      // Get note info from cache (including snippet for note-level suggestions)
      const noteInfo = indexDb
        .select({
          path: noteCache.path,
          title: noteCache.title,
          snippet: noteCache.snippet,
          emoji: noteCache.emoji
        })
        .from(noteCache)
        .where(eq(noteCache.id, row.note_id))
        .get()

      if (noteInfo) {
        // Convert distance to similarity score (0-1, higher = more similar)
        // Cosine distance ranges from 0 (identical) to 2 (opposite)
        const similarityScore = 1 - row.distance / 2

        similarities.push({
          noteId: row.note_id,
          notePath: noteInfo.path,
          noteTitle: noteInfo.title,
          score: similarityScore,
          snippet: noteInfo.snippet || '',
          emoji: noteInfo.emoji ?? null
        })
      }
    }

    return similarities
  } catch (error) {
    log.error('Similarity search failed:', error)
    return []
  }
}

/**
 * Get folder path from note path, relative to the notes directory.
 * Note paths are stored relative to vault root (e.g., "notes/kaan/test.md"),
 * but folder paths for filing should be relative to notes dir (e.g., "kaan").
 *
 * Also handles corrupted paths like "notes/notes/kaan" from previous bugs.
 */
function getFolderFromPath(notePath: string): string {
  const config = getConfig()
  const noteFolder = config.defaultNoteFolder // e.g., "notes"

  // Extract folder part (remove filename)
  let folderPath = notePath.split('/').slice(0, -1).join('/')

  if (folderPath.length <= 0) {
    return '' // Root folder
  }

  // Strip the notes folder prefix - may need multiple passes for corrupted paths
  // e.g., "notes/notes/kaan" -> "notes/kaan" -> "kaan"
  let prevPath = ''
  while (folderPath !== prevPath) {
    prevPath = folderPath

    if (folderPath === noteFolder) {
      folderPath = '' // Root of notes folder
      break
    }
    if (folderPath.startsWith(noteFolder + '/')) {
      folderPath = folderPath.slice(noteFolder.length + 1)
    }
  }

  return folderPath
}

// ============================================================================
// Filing History Analysis
// ============================================================================

/**
 * Get filing patterns from history
 */
function getFilingPatterns(itemType: string): FilingPattern[] {
  try {
    const db = requireDatabase()

    const patterns = db
      .select({
        destination: filingHistory.filedTo,
        action: filingHistory.filedAction,
        count: sql<number>`count(*)`,
        tags: filingHistory.tags
      })
      .from(filingHistory)
      .where(eq(filingHistory.itemType, itemType))
      .groupBy(filingHistory.filedTo, filingHistory.filedAction)
      .orderBy(desc(sql`count(*)`))
      .limit(10)
      .all()

    // Convert full note paths to folder paths relative to notes directory
    // filedTo contains paths like "notes/kaan/my-note.md", we need "kaan"
    return patterns.map((p) => ({
      destination: getFolderFromPath(p.destination),
      action: p.action,
      count: p.count,
      tags: (p.tags as string[]) || []
    }))
  } catch {
    return []
  }
}

/**
 * Analyze recent filing patterns to find frequently used destinations
 */
function getRecentFilingDestinations(limit: number = 5): { path: string; count: number }[] {
  try {
    const db = requireDatabase()

    const recent = db
      .select({
        path: filingHistory.filedTo,
        count: sql<number>`count(*)`
      })
      .from(filingHistory)
      .where(eq(filingHistory.filedAction, 'folder'))
      .groupBy(filingHistory.filedTo)
      .orderBy(desc(sql`count(*)`))
      .limit(limit)
      .all()

    // Convert full note paths to folder paths relative to notes directory
    // filedTo contains paths like "notes/kaan/my-note.md", we need "kaan"
    return recent.map((r) => ({ path: getFolderFromPath(r.path), count: r.count }))
  } catch {
    return []
  }
}

// ============================================================================
// Suggestion Generation
// ============================================================================

/**
 * Get filing suggestions for an inbox item
 *
 * Uses:
 * 1. Embedding similarity with existing notes (via sqlite-vec)
 * 2. Filing history patterns
 * 3. Recent filing destinations
 *
 * @param itemId - The inbox item ID
 * @returns Array of filing suggestions
 */
export async function getSuggestions(itemId: string): Promise<FilingSuggestion[]> {
  if (!isAIEnabled()) {
    log.debug('AI disabled, returning empty suggestions')
    return []
  }

  // Check if model is loaded (don't block on loading)
  if (!isModelLoaded()) {
    log.debug('Model not loaded, returning history-based suggestions only')
  }

  try {
    const db = requireDatabase()
    const item = db.select().from(inboxItems).where(eq(inboxItems.id, itemId)).get()

    if (!item) {
      log.debug(`Item not found: ${itemId}`)
      return []
    }

    const suggestions: FilingSuggestion[] = []
    const seenDestinations = new Set<string>()

    // Build content for similarity search
    const content = [item.title, item.content].filter(Boolean).join('\n\n')

    // 1. Find similar notes → suggest both folders AND direct note links
    const noteSuggestions: FilingSuggestion[] = []

    if (isModelLoaded() && content.length >= MIN_CONTENT_LENGTH) {
      const similarNotes = await findSimilarNotes(content, 8)

      for (const note of similarNotes) {
        // 1a. Folder suggestion (existing behavior)
        const folder = getFolderFromPath(note.notePath)
        const destKey = folder || 'root'

        if (!seenDestinations.has(destKey) && suggestions.length < MAX_SUGGESTIONS) {
          seenDestinations.add(destKey)

          suggestions.push({
            destination: {
              type: 'folder',
              path: folder
            },
            confidence: note.score,
            reason: folder
              ? `Similar to "${note.noteTitle}" in ${folder}`
              : `Similar to "${note.noteTitle}" in root`,
            suggestedTags: []
          })
        }

        // 1b. Note-level suggestion: "link to this note"
        if (noteSuggestions.length < MAX_NOTE_SUGGESTIONS) {
          const suggestedNote: SuggestedNote = {
            id: note.noteId,
            title: note.noteTitle,
            snippet: note.snippet.slice(0, 150),
            emoji: note.emoji
          }
          noteSuggestions.push({
            destination: {
              type: 'note',
              noteId: note.noteId,
              noteTitle: note.noteTitle
            },
            confidence: note.score,
            reason: `Similar content (${Math.round(note.score * 100)}% match)`,
            suggestedTags: [],
            suggestedNote
          })
        }
      }
    }

    // 2. If we don't have enough suggestions, add from filing history
    if (suggestions.length < MAX_SUGGESTIONS) {
      const patterns = getFilingPatterns(item.type)

      for (const pattern of patterns) {
        if (seenDestinations.has(pattern.destination)) continue

        seenDestinations.add(pattern.destination)
        const confidence = Math.min(0.7, 0.3 + pattern.count * 0.1)

        suggestions.push({
          destination: {
            type: pattern.action as 'folder' | 'note' | 'new-note',
            path: pattern.destination
          },
          confidence,
          reason: `You've filed ${pattern.count} similar ${item.type}s here`,
          suggestedTags: pattern.tags
        })

        if (suggestions.length >= MAX_SUGGESTIONS) break
      }
    }

    // 3. If still not enough, add most recent filing destinations
    if (suggestions.length < MAX_SUGGESTIONS) {
      const recentDests = getRecentFilingDestinations(5)

      for (const dest of recentDests) {
        if (seenDestinations.has(dest.path)) continue

        seenDestinations.add(dest.path)
        const confidence = Math.min(0.5, 0.2 + dest.count * 0.05)

        suggestions.push({
          destination: {
            type: 'folder',
            path: dest.path
          },
          confidence,
          reason: `Recently used (${dest.count} items)`,
          suggestedTags: []
        })

        if (suggestions.length >= MAX_SUGGESTIONS) break
      }
    }

    // Sort folder suggestions by confidence, then append note suggestions
    suggestions.sort((a, b) => b.confidence - a.confidence)
    noteSuggestions.sort((a, b) => b.confidence - a.confidence)

    const combined = [
      ...suggestions.slice(0, MAX_SUGGESTIONS),
      ...noteSuggestions.slice(0, MAX_NOTE_SUGGESTIONS)
    ]

    log.debug(
      `Generated ${suggestions.length} folder + ${noteSuggestions.length} note suggestions for ${itemId}`
    )
    return combined
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error'
    log.error('Failed to get suggestions:', message)
    return []
  }
}

// ============================================================================
// Feedback Tracking
// ============================================================================

/**
 * Track user feedback on a suggestion
 *
 * @param itemId - The inbox item ID
 * @param itemType - Type of item
 * @param suggestedTo - What was suggested
 * @param actualTo - What user chose
 * @param confidence - Confidence of suggestion (0-1)
 * @param suggestedTags - Tags that were suggested
 * @param actualTags - Tags that were applied
 */
export function trackSuggestionFeedback(
  itemId: string,
  itemType: string,
  suggestedTo: string,
  actualTo: string,
  confidence: number,
  suggestedTags: string[] = [],
  actualTags: string[] = []
): void {
  try {
    const db = requireDatabase()

    const accepted = suggestedTo === actualTo

    db.insert(suggestionFeedback)
      .values({
        id: generateId(),
        itemId,
        itemType,
        suggestedTo,
        actualTo,
        accepted,
        confidence: Math.round(confidence * 100),
        suggestedTags,
        actualTags,
        createdAt: new Date().toISOString()
      })
      .run()

    log.debug(
      `Tracked feedback: ${accepted ? 'accepted' : 'rejected'} (${itemType} -> ${actualTo})`
    )
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error'
    log.error('Failed to track feedback:', message)
  }
}

/**
 * Get suggestion accuracy stats
 */
export function getSuggestionStats(): {
  totalSuggestions: number
  acceptedCount: number
  rejectedCount: number
  acceptanceRate: number
} {
  try {
    const db = requireDatabase()

    const stats = db
      .select({
        total: sql<number>`count(*)`,
        accepted: sql<number>`sum(case when accepted = 1 then 1 else 0 end)`
      })
      .from(suggestionFeedback)
      .get()

    const total = stats?.total || 0
    const accepted = stats?.accepted || 0

    return {
      totalSuggestions: total,
      acceptedCount: accepted,
      rejectedCount: total - accepted,
      acceptanceRate: total > 0 ? accepted / total : 0
    }
  } catch {
    return {
      totalSuggestions: 0,
      acceptedCount: 0,
      rejectedCount: 0,
      acceptanceRate: 0
    }
  }
}

// ============================================================================
// Note Folder Suggestions (Phase 27 - Move to Folder)
// ============================================================================

/**
 * Folder suggestion for moving a note
 */
export interface FolderSuggestion {
  /** Folder path relative to notes/ */
  path: string
  /** Confidence score (0-1) */
  confidence: number
  /** Reason for suggesting this folder */
  reason: string
}

/**
 * Get folder suggestions for moving an existing note.
 *
 * Uses:
 * 1. Embedding similarity with notes in other folders
 * 2. Filing history patterns
 * 3. Recent filing destinations
 *
 * @param noteId - The note ID to get suggestions for
 * @returns Array of folder suggestions (max 3)
 */
export async function getNoteFolderSuggestions(noteId: string): Promise<FolderSuggestion[]> {
  if (!isAIEnabled()) {
    log.debug('AI disabled, returning empty folder suggestions')
    return []
  }

  try {
    // Get the note content
    const note = await getNoteById(noteId)
    if (!note) {
      log.debug(`Note not found: ${noteId}`)
      return []
    }

    // Get current folder to exclude from suggestions
    const currentFolder = getFolderFromPath(note.path)

    const suggestions: FolderSuggestion[] = []
    const seenFolders = new Set<string>()

    // Always exclude current folder
    seenFolders.add(currentFolder)

    // Build content for similarity search
    const content = [note.title, note.content].filter(Boolean).join('\n\n')

    // 1. Find similar notes and suggest their folders (only if model is loaded)
    if (isModelLoaded() && content.length >= MIN_CONTENT_LENGTH) {
      const similarNotes = await findSimilarNotes(content, 10)

      for (const similar of similarNotes) {
        // Skip notes in the same folder
        const folder = getFolderFromPath(similar.notePath)
        if (seenFolders.has(folder)) continue

        seenFolders.add(folder)

        suggestions.push({
          path: folder,
          confidence: similar.score,
          reason: folder
            ? `Similar to "${similar.noteTitle}" in ${folder}`
            : `Similar to "${similar.noteTitle}" in root`
        })

        if (suggestions.length >= MAX_SUGGESTIONS) break
      }
    }

    // 2. If we don't have enough suggestions, add from filing history
    if (suggestions.length < MAX_SUGGESTIONS) {
      const patterns = getFilingPatterns('note')

      for (const pattern of patterns) {
        if (seenFolders.has(pattern.destination)) continue

        seenFolders.add(pattern.destination)
        const confidence = Math.min(0.7, 0.3 + pattern.count * 0.1)

        suggestions.push({
          path: pattern.destination,
          confidence,
          reason: `You've moved ${pattern.count} notes here before`
        })

        if (suggestions.length >= MAX_SUGGESTIONS) break
      }
    }

    // 3. If still not enough, add most recent filing destinations
    if (suggestions.length < MAX_SUGGESTIONS) {
      const recentDests = getRecentFilingDestinations(5)

      for (const dest of recentDests) {
        if (seenFolders.has(dest.path)) continue

        seenFolders.add(dest.path)
        const confidence = Math.min(0.5, 0.2 + dest.count * 0.05)

        suggestions.push({
          path: dest.path,
          confidence,
          reason: `Recently used (${dest.count} items)`
        })

        if (suggestions.length >= MAX_SUGGESTIONS) break
      }
    }

    // Sort by confidence
    suggestions.sort((a, b) => b.confidence - a.confidence)

    log.debug(`Generated ${suggestions.length} folder suggestions for note ${noteId}`)
    return suggestions.slice(0, MAX_SUGGESTIONS)
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error'
    log.error('Failed to get folder suggestions:', message)
    return []
  }
}
