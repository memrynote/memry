/**
 * AI-Powered Filing Suggestions
 *
 * Provides smart filing suggestions using local embeddings (all-MiniLM-L6-v2)
 * and sqlite-vec for efficient vector similarity search.
 * Learns from filing history to improve suggestions over time.
 *
 * @module inbox/suggestions
 */

import { createLogger } from '../lib/logger'
import { broadcastToAllWindows } from '../lib/window-broadcast'
import { getDatabase, requireDatabase, getIndexDatabase, getRawIndexDatabase } from '../database'
import {
  inboxItems,
  inboxItemTags,
  filingHistory,
  suggestionFeedback
} from '@memry/db-schema/schema/inbox'
import { noteCache, noteTags } from '@memry/db-schema/schema/notes-cache'
import { eq, desc, sql, inArray } from 'drizzle-orm'
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
import { scoreFolders, type FolderScore } from './folder-scoring'
import { buildEmbeddingInput } from '../lib/embedding-input'

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
  broadcastToAllWindows(SettingsChannels.events.EMBEDDING_PROGRESS, {
    current,
    total,
    phase
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

    // Keep only close-enough hits, then fetch all their note info in one
    // query (avoids an N+1 lookup per KNN hit).
    const nearby = results.filter((row) => row.distance <= MAX_DISTANCE_THRESHOLD)
    if (nearby.length === 0) return []

    const infoById = new Map<
      string,
      { path: string; title: string; snippet: string | null; emoji: string | null }
    >()
    const rows = indexDb
      .select({
        id: noteCache.id,
        path: noteCache.path,
        title: noteCache.title,
        snippet: noteCache.snippet,
        emoji: noteCache.emoji
      })
      .from(noteCache)
      .where(
        inArray(
          noteCache.id,
          nearby.map((row) => row.note_id)
        )
      )
      .all()
    for (const row of rows) infoById.set(row.id, row)

    // Preserve KNN (distance) order from `nearby`.
    const similarities: SimilarNote[] = []
    for (const row of nearby) {
      const info = infoById.get(row.note_id)
      if (!info) continue
      similarities.push({
        noteId: row.note_id,
        notePath: info.path,
        noteTitle: info.title,
        // Cosine distance ranges 0 (identical)..2 (opposite) → similarity 0..1.
        score: 1 - row.distance / 2,
        snippet: info.snippet || '',
        emoji: info.emoji ?? null
      })
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

/**
 * Confidence for a folder surfaced by filing-history patterns.
 * More prior filings → higher confidence, capped at 0.7.
 */
function filingHistoryConfidence(count: number): number {
  return Math.min(0.7, 0.3 + count * 0.1)
}

/**
 * Confidence for a folder surfaced only by recent-destination frequency.
 * Weaker signal than history patterns, capped at 0.5.
 */
function recentDestinationConfidence(count: number): number {
  return Math.min(0.5, 0.2 + count * 0.05)
}

/** A folder candidate produced by the history → recents fallback ladder. */
interface FolderFallbackCandidate {
  path: string
  confidence: number
  tags: string[]
  /** Filing action recorded for the pattern ('folder' for recents). */
  action: string
  source: 'history' | 'recent'
  count: number
}

/**
 * Shared fallback ladder for folder suggestions: filing-history patterns
 * first, then recent destinations. Skips any folder already in `seen`
 * (mutating it as it goes) and returns at most `limit` candidates in order.
 * Callers map these to their own suggestion shape and reason text.
 */
function collectFolderFallbacks(
  itemType: string,
  seen: Set<string>,
  limit: number
): FolderFallbackCandidate[] {
  const out: FolderFallbackCandidate[] = []
  if (limit <= 0) return out

  for (const pattern of getFilingPatterns(itemType)) {
    if (seen.has(pattern.destination)) continue
    seen.add(pattern.destination)
    out.push({
      path: pattern.destination,
      confidence: filingHistoryConfidence(pattern.count),
      tags: pattern.tags,
      action: pattern.action,
      source: 'history',
      count: pattern.count
    })
    if (out.length >= limit) return out
  }

  for (const dest of getRecentFilingDestinations(5)) {
    if (seen.has(dest.path)) continue
    seen.add(dest.path)
    out.push({
      path: dest.path,
      confidence: recentDestinationConfidence(dest.count),
      tags: [],
      action: 'folder',
      source: 'recent',
      count: dest.count
    })
    if (out.length >= limit) return out
  }

  return out
}

/** Max KNN neighbours to pull for folder aggregation (raised for clustering). */
const SIMILAR_NOTE_LIMIT = 20

/**
 * Folder suggestions below this blended confidence are suppressed. Folder
 * filing is a higher-stakes guess than showing a similar note, so it gets a
 * stricter floor than the note-link feature (Codex #4/#18).
 */
const FOLDER_MIN_CONFIDENCE = 0.45

/**
 * Split text into a set of lowercase word tokens for lexical matching.
 * ponytail: exact-token match, no stemming — singular/plural won't match.
 */
function tokenize(text: string): Set<string> {
  const tokens = new Set<string>()
  for (const raw of text.toLowerCase().split(/[^a-z0-9]+/)) {
    if (raw.length >= 2) tokens.add(raw)
  }
  return tokens
}

/** Distinct folders that currently hold notes (derived from note paths). */
function getDistinctFolders(): string[] {
  try {
    const indexDb = requireIndexDatabase()
    const rows = indexDb.selectDistinct({ path: noteCache.path }).from(noteCache).all()
    const folders = new Set<string>()
    for (const row of rows) folders.add(getFolderFromPath(row.path))
    return [...folders]
  } catch {
    return []
  }
}

/**
 * Score each folder by how many of its name tokens appear in the item, so the
 * folder NAME is a signal (and cold-start works before any embeddings exist).
 * Returns only folders with a non-zero match.
 */
function computeNameMatches(itemTokens: Set<string>): Map<string, number> {
  const matches = new Map<string, number>()
  if (itemTokens.size === 0) return matches

  for (const folder of getDistinctFolders()) {
    if (!folder) continue
    const folderTokens = tokenize(folder.replace(/\//g, ' '))
    if (folderTokens.size === 0) continue
    let hit = 0
    for (const token of folderTokens) if (itemTokens.has(token)) hit++
    if (hit > 0) matches.set(folder, hit / folderTokens.size)
  }
  return matches
}

/**
 * Score each folder by how many of the item's tags also appear on notes inside
 * it. Member tags stand in for the folder-level tags Memry does not store.
 * Returns only folders with a non-zero overlap.
 */
function computeTagMatches(itemTags: string[]): Map<string, number> {
  const matches = new Map<string, number>()
  const tags = itemTags.filter(Boolean)
  if (tags.length === 0) return matches

  try {
    const indexDb = requireIndexDatabase()
    const rows = indexDb
      .select({ path: noteCache.path, tag: noteTags.tag })
      .from(noteTags)
      .innerJoin(noteCache, eq(noteTags.noteId, noteCache.id))
      .where(inArray(noteTags.tag, tags))
      .all()

    const perFolder = new Map<string, Set<string>>()
    for (const row of rows) {
      const folder = getFolderFromPath(row.path)
      const set = perFolder.get(folder) ?? new Set<string>()
      set.add(row.tag)
      perFolder.set(folder, set)
    }
    for (const [folder, tagSet] of perFolder) {
      matches.set(folder, tagSet.size / tags.length)
    }
  } catch {
    return matches
  }
  return matches
}

/** The tags applied to one note, read from the index DB ([] on any error). */
function getNoteTagsFromIndex(noteId: string): string[] {
  try {
    return requireIndexDatabase()
      .select({ tag: noteTags.tag })
      .from(noteTags)
      .where(eq(noteTags.noteId, noteId))
      .all()
      .map((row) => row.tag)
  } catch {
    return []
  }
}

/** Build a human reason for a folder suggestion from its dominant signal. */
function folderReason(score: FolderScore): string {
  if (score.topNoteTitle) {
    return score.path
      ? `Similar to "${score.topNoteTitle}" in ${score.path}`
      : `Similar to "${score.topNoteTitle}" in root`
  }
  if (score.components.name > 0) {
    return score.path ? `Folder name matches "${score.path}"` : 'Matches the root folder'
  }
  if (score.components.tag > 0) {
    return score.path ? `Shared tags with notes in ${score.path}` : 'Shared tags with root notes'
  }
  return score.path ? `Suggested folder ${score.path}` : 'Root folder'
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

  try {
    const db = requireDatabase()
    const item = db.select().from(inboxItems).where(eq(inboxItems.id, itemId)).get()

    if (!item) {
      log.debug(`Item not found: ${itemId}`)
      return []
    }

    const suggestions: FilingSuggestion[] = []
    const seenDestinations = new Set<string>()

    // Build content for similarity search (symmetric with stored embeddings).
    const content = buildEmbeddingInput({ title: item.title, content: item.content })

    // 1. Find similar notes → suggest both folders AND direct note links
    const noteSuggestions: FilingSuggestion[] = []

    if (content.length >= MIN_CONTENT_LENGTH) {
      const similarNotes = await findSimilarNotes(content, SIMILAR_NOTE_LIMIT)

      // Folder suggestions: aggregate similarity hits + folder name + member
      // tags into folder-centric scores (a cluster beats a single fluke).
      const itemTags = db
        .select({ tag: inboxItemTags.tag })
        .from(inboxItemTags)
        .where(eq(inboxItemTags.itemId, itemId))
        .all()
        .map((row) => row.tag)
      const folderScores = scoreFolders({
        hits: similarNotes.map((note) => ({
          folder: getFolderFromPath(note.notePath),
          similarity: note.score,
          noteTitle: note.noteTitle
        })),
        nameMatches: computeNameMatches(tokenize(content)),
        tagMatches: computeTagMatches(itemTags),
        minConfidence: FOLDER_MIN_CONFIDENCE,
        limit: MAX_SUGGESTIONS
      })
      for (const score of folderScores) {
        const destKey = score.path || 'root'
        if (seenDestinations.has(destKey)) continue
        seenDestinations.add(destKey)
        suggestions.push({
          destination: { type: 'folder', path: score.path },
          confidence: score.confidence,
          reason: folderReason(score),
          suggestedTags: []
        })
      }

      // Note-level suggestions: "link to this note" (precision@1, unchanged).
      for (const note of similarNotes) {
        if (noteSuggestions.length >= MAX_NOTE_SUGGESTIONS) break
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

    // 2 & 3. Backfill from the shared history → recents fallback ladder.
    const fallbacks = collectFolderFallbacks(
      item.type,
      seenDestinations,
      MAX_SUGGESTIONS - suggestions.length
    )
    for (const fallback of fallbacks) {
      suggestions.push({
        destination: {
          type:
            fallback.source === 'history'
              ? (fallback.action as 'folder' | 'note' | 'new-note')
              : 'folder',
          path: fallback.path
        },
        confidence: fallback.confidence,
        reason:
          fallback.source === 'history'
            ? `You've filed ${fallback.count} similar ${item.type}s here`
            : `Recently used (${fallback.count} items)`,
        suggestedTags: fallback.tags
      })
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

    // Build content for similarity search (symmetric with stored embeddings).
    const content = buildEmbeddingInput({ title: note.title, content: note.content })

    // 1. Score candidate folders from similar notes + folder name + member
    //    tags, excluding the note's current folder.
    if (content.length >= MIN_CONTENT_LENGTH) {
      const similarNotes = await findSimilarNotes(content, SIMILAR_NOTE_LIMIT)
      const noteTagList = getNoteTagsFromIndex(noteId)

      const folderScores = scoreFolders({
        hits: similarNotes.map((similar) => ({
          folder: getFolderFromPath(similar.notePath),
          similarity: similar.score,
          noteTitle: similar.noteTitle
        })),
        nameMatches: computeNameMatches(tokenize(content)),
        tagMatches: computeTagMatches(noteTagList),
        exclude: seenFolders,
        minConfidence: FOLDER_MIN_CONFIDENCE,
        limit: MAX_SUGGESTIONS
      })

      for (const score of folderScores) {
        seenFolders.add(score.path)
        suggestions.push({
          path: score.path,
          confidence: score.confidence,
          reason: folderReason(score)
        })
      }
    }

    // 2 & 3. Backfill from the shared history → recents fallback ladder.
    const fallbacks = collectFolderFallbacks(
      'note',
      seenFolders,
      MAX_SUGGESTIONS - suggestions.length
    )
    for (const fallback of fallbacks) {
      suggestions.push({
        path: fallback.path,
        confidence: fallback.confidence,
        reason:
          fallback.source === 'history'
            ? `You've moved ${fallback.count} notes here before`
            : `Recently used (${fallback.count} items)`
      })
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
