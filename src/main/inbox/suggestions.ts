/**
 * AI-Powered Filing Suggestions
 *
 * Provides smart filing suggestions using OpenAI embeddings
 * and content similarity analysis. Learns from filing history
 * to improve suggestions over time.
 *
 * @module inbox/suggestions
 */

import { BrowserWindow } from 'electron'
import { getDatabase, getIndexDatabase } from '../database'
import { inboxItems, filingHistory, suggestionFeedback } from '@shared/db/schema/inbox'
import { noteEmbeddings, CHARS_PER_TOKEN } from '@shared/db/schema/embeddings'
import { noteCache } from '@shared/db/schema/notes-cache'
import { eq, desc, sql } from 'drizzle-orm'
import { generateId } from '../lib/id'
import { getSetting } from '@shared/db/queries/settings'
import { listNotesFromCache } from '@shared/db/queries/notes'
import { getNoteById } from '../vault/notes'
import { SettingsChannels } from '@shared/ipc-channels'
import type { FilingSuggestion } from '@shared/contracts/inbox-api'

// ============================================================================
// Types
// ============================================================================

interface EmbeddingResult {
  embedding: number[]
  tokensUsed: number
}

interface SimilarNote {
  noteId: string
  notePath: string
  noteTitle: string
  score: number
}

interface FilingPattern {
  destination: string
  action: string
  count: number
  tags: string[]
}

// ============================================================================
// Constants
// ============================================================================

const AI_SETTINGS_KEYS = {
  OPENAI_API_KEY: 'ai.openaiApiKey',
  ENABLED: 'ai.enabled',
  EMBEDDING_MODEL: 'ai.embeddingModel'
}

/** Minimum similarity score to include in suggestions (0-1) */
const MIN_SIMILARITY_THRESHOLD = 0.3

/** Maximum number of suggestions to return */
const MAX_SUGGESTIONS = 3

/** Minimum content length to generate embedding */
const MIN_CONTENT_LENGTH = 10

/** Maximum characters for embedding input */
const MAX_EMBEDDING_CHARS = 8000 * CHARS_PER_TOKEN

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
 * Check if AI is enabled and API key is configured
 */
function getAIConfig(): { apiKey: string; model: string } | null {
  try {
    const db = getDatabase()
    const apiKey = getSetting(db, AI_SETTINGS_KEYS.OPENAI_API_KEY)
    const enabled = getSetting(db, AI_SETTINGS_KEYS.ENABLED)
    const model = getSetting(db, AI_SETTINGS_KEYS.EMBEDDING_MODEL) || 'text-embedding-3-small'

    if (!apiKey || enabled === 'false') {
      return null
    }

    return { apiKey, model }
  } catch {
    return null
  }
}

/**
 * Emit progress event to all windows
 */
function emitProgress(computed: number, total: number, status: string): void {
  BrowserWindow.getAllWindows().forEach((win) => {
    win.webContents.send(SettingsChannels.events.EMBEDDING_PROGRESS, {
      computed,
      total,
      status
    })
  })
}

// ============================================================================
// Embedding Functions
// ============================================================================

/**
 * Generate embedding for text using OpenAI API
 *
 * @param text - The text to embed
 * @returns Embedding vector and tokens used, or null on error
 */
export async function generateEmbedding(text: string): Promise<EmbeddingResult | null> {
  const config = getAIConfig()
  if (!config) {
    console.log('[Suggestions] AI not configured, skipping embedding')
    return null
  }

  if (!text || text.length < MIN_CONTENT_LENGTH) {
    console.log('[Suggestions] Text too short for embedding')
    return null
  }

  // Truncate if too long
  const truncatedText = text.substring(0, MAX_EMBEDDING_CHARS)

  try {
    const { default: OpenAI } = await import('openai')
    const openai = new OpenAI({ apiKey: config.apiKey })

    const response = await openai.embeddings.create({
      model: config.model,
      input: truncatedText
    })

    return {
      embedding: response.data[0].embedding,
      tokensUsed: response.usage?.total_tokens || 0
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error'
    console.error('[Suggestions] Embedding generation failed:', message)
    return null
  }
}

/**
 * Calculate cosine similarity between two embedding vectors
 *
 * @param a - First embedding vector
 * @param b - Second embedding vector
 * @returns Similarity score between 0 and 1
 */
export function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length) {
    console.error('[Suggestions] Vector dimension mismatch:', a.length, 'vs', b.length)
    return 0
  }

  let dotProduct = 0
  let normA = 0
  let normB = 0

  for (let i = 0; i < a.length; i++) {
    dotProduct += a[i] * b[i]
    normA += a[i] * a[i]
    normB += b[i] * b[i]
  }

  if (normA === 0 || normB === 0) {
    return 0
  }

  return dotProduct / (Math.sqrt(normA) * Math.sqrt(normB))
}

/**
 * Convert Buffer to Float32Array embedding
 */
function bufferToEmbedding(buffer: Buffer): number[] {
  const float32Array = new Float32Array(buffer.buffer, buffer.byteOffset, buffer.length / 4)
  return Array.from(float32Array)
}

/**
 * Convert embedding to Buffer for storage
 */
function embeddingToBuffer(embedding: number[]): Buffer {
  const float32Array = new Float32Array(embedding)
  return Buffer.from(float32Array.buffer)
}

// ============================================================================
// Note Embedding Management
// ============================================================================

/**
 * Get stored embedding for a note
 */
export function getNoteEmbedding(noteId: string): number[] | null {
  try {
    const indexDb = requireIndexDatabase()
    const row = indexDb.select().from(noteEmbeddings).where(eq(noteEmbeddings.noteId, noteId)).get()

    if (!row) return null

    return bufferToEmbedding(row.embedding)
  } catch {
    return null
  }
}

/**
 * Store embedding for a note
 */
export function storeNoteEmbedding(
  noteId: string,
  embedding: number[],
  contentHash: string,
  model: string
): void {
  const indexDb = requireIndexDatabase()

  indexDb
    .insert(noteEmbeddings)
    .values({
      noteId,
      embedding: embeddingToBuffer(embedding),
      contentHash,
      model,
      computedAt: new Date().toISOString()
    })
    .onConflictDoUpdate({
      target: noteEmbeddings.noteId,
      set: {
        embedding: embeddingToBuffer(embedding),
        contentHash,
        model,
        computedAt: new Date().toISOString()
      }
    })
    .run()
}

/**
 * Check if note needs embedding update
 */
function needsEmbeddingUpdate(noteId: string, currentHash: string): boolean {
  try {
    const indexDb = requireIndexDatabase()
    const existing = indexDb
      .select({ contentHash: noteEmbeddings.contentHash })
      .from(noteEmbeddings)
      .where(eq(noteEmbeddings.noteId, noteId))
      .get()

    return !existing || existing.contentHash !== currentHash
  } catch {
    return true
  }
}

/**
 * Compute and store embedding for a single note
 */
export async function updateNoteEmbedding(noteId: string): Promise<boolean> {
  try {
    const note = await getNoteById(noteId)
    if (!note) {
      console.log(`[Suggestions] Note not found: ${noteId}`)
      return false
    }

    // Check if update needed
    const indexDb = requireIndexDatabase()
    const cached = indexDb
      .select({ contentHash: noteCache.contentHash })
      .from(noteCache)
      .where(eq(noteCache.id, noteId))
      .get()

    if (!cached) {
      console.log(`[Suggestions] Note not in cache: ${noteId}`)
      return false
    }

    if (!needsEmbeddingUpdate(noteId, cached.contentHash)) {
      console.log(`[Suggestions] Embedding up to date: ${noteId}`)
      return true
    }

    // Generate embedding
    const result = await generateEmbedding(note.content)
    if (!result) {
      return false
    }

    // Store embedding
    const config = getAIConfig()
    storeNoteEmbedding(
      noteId,
      result.embedding,
      cached.contentHash,
      config?.model || 'text-embedding-3-small'
    )

    console.log(`[Suggestions] Updated embedding for: ${note.title}`)
    return true
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error'
    console.error(`[Suggestions] Failed to update embedding for ${noteId}:`, message)
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
  const config = getAIConfig()
  if (!config) {
    return { success: false, computed: 0, skipped: 0, error: 'AI not configured' }
  }

  try {
    const indexDb = requireIndexDatabase()
    const notes = listNotesFromCache(indexDb, { limit: 10000 })

    let computed = 0
    let skipped = 0
    const total = notes.length

    emitProgress(0, total, 'Starting embedding indexing...')

    for (let i = 0; i < notes.length; i++) {
      const noteItem = notes[i]

      // Check if update needed
      if (!needsEmbeddingUpdate(noteItem.id, noteItem.contentHash)) {
        skipped++
        continue
      }

      // Get full note content
      const note = await getNoteById(noteItem.id)
      if (!note || !note.content || note.content.length < MIN_CONTENT_LENGTH) {
        skipped++
        continue
      }

      // Generate embedding
      const result = await generateEmbedding(note.content)
      if (!result) {
        skipped++
        continue
      }

      // Store embedding
      storeNoteEmbedding(noteItem.id, result.embedding, noteItem.contentHash, config.model)
      computed++

      // Emit progress every 10 notes
      if (computed % 10 === 0) {
        emitProgress(computed + skipped, total, `Indexed ${computed} notes...`)
      }

      // Small delay to avoid rate limiting
      if (computed % 50 === 0) {
        await new Promise((resolve) => setTimeout(resolve, 1000))
      }
    }

    emitProgress(total, total, `Complete: ${computed} indexed, ${skipped} skipped`)
    console.log(`[Suggestions] Reindex complete: ${computed} computed, ${skipped} skipped`)

    return { success: true, computed, skipped }
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error'
    console.error('[Suggestions] Reindex failed:', message)
    return { success: false, computed: 0, skipped: 0, error: message }
  }
}

// ============================================================================
// Similarity Search
// ============================================================================

/**
 * Find notes similar to the given content
 */
async function findSimilarNotes(content: string, limit: number = 5): Promise<SimilarNote[]> {
  // Generate embedding for the content
  const result = await generateEmbedding(content)
  if (!result) {
    return []
  }

  const contentEmbedding = result.embedding
  const indexDb = requireIndexDatabase()

  // Get all note embeddings
  const embeddings = indexDb
    .select({
      noteId: noteEmbeddings.noteId,
      embedding: noteEmbeddings.embedding
    })
    .from(noteEmbeddings)
    .all()

  if (embeddings.length === 0) {
    console.log('[Suggestions] No note embeddings found')
    return []
  }

  // Calculate similarity for each note
  const similarities: SimilarNote[] = []

  for (const row of embeddings) {
    const noteEmbedding = bufferToEmbedding(row.embedding)
    const score = cosineSimilarity(contentEmbedding, noteEmbedding)

    if (score >= MIN_SIMILARITY_THRESHOLD) {
      // Get note info
      const noteInfo = indexDb
        .select({ path: noteCache.path, title: noteCache.title })
        .from(noteCache)
        .where(eq(noteCache.id, row.noteId))
        .get()

      if (noteInfo) {
        similarities.push({
          noteId: row.noteId,
          notePath: noteInfo.path,
          noteTitle: noteInfo.title,
          score
        })
      }
    }
  }

  // Sort by similarity score descending
  similarities.sort((a, b) => b.score - a.score)

  return similarities.slice(0, limit)
}

/**
 * Get folder path from note path
 */
function getFolderFromPath(notePath: string): string {
  const parts = notePath.split('/')
  if (parts.length <= 1) {
    return '' // Root folder
  }
  return parts.slice(0, -1).join('/')
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

    return patterns.map((p) => ({
      destination: p.destination,
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

    return recent.map((r) => ({ path: r.path, count: r.count }))
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
 * 1. Embedding similarity with existing notes
 * 2. Filing history patterns
 * 3. Tag matching
 *
 * @param itemId - The inbox item ID
 * @returns Array of filing suggestions
 */
export async function getSuggestions(itemId: string): Promise<FilingSuggestion[]> {
  const config = getAIConfig()
  if (!config) {
    console.log('[Suggestions] AI not configured, returning empty suggestions')
    return []
  }

  try {
    const db = requireDatabase()
    const item = db.select().from(inboxItems).where(eq(inboxItems.id, itemId)).get()

    if (!item) {
      console.log(`[Suggestions] Item not found: ${itemId}`)
      return []
    }

    const suggestions: FilingSuggestion[] = []
    const seenDestinations = new Set<string>()

    // Build content for similarity search
    const content = [item.title, item.content].filter(Boolean).join('\n\n')

    // 1. Find similar notes and suggest their folders
    if (content.length >= MIN_CONTENT_LENGTH) {
      const similarNotes = await findSimilarNotes(content, 5)

      for (const note of similarNotes) {
        const folder = getFolderFromPath(note.notePath)
        const destKey = folder || 'root'

        if (!seenDestinations.has(destKey)) {
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

        if (suggestions.length >= MAX_SUGGESTIONS) break
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

    // Sort by confidence
    suggestions.sort((a, b) => b.confidence - a.confidence)

    console.log(`[Suggestions] Generated ${suggestions.length} suggestions for ${itemId}`)
    return suggestions.slice(0, MAX_SUGGESTIONS)
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error'
    console.error('[Suggestions] Failed to get suggestions:', message)
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
 * @param confidence - Confidence of suggestion (0-100)
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

    console.log(
      `[Suggestions] Tracked feedback: ${accepted ? 'accepted' : 'rejected'} (${itemType} -> ${actualTo})`
    )
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error'
    console.error('[Suggestions] Failed to track feedback:', message)
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
