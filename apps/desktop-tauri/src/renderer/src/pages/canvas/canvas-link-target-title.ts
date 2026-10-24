/**
 * Resolves the title of the item a card shows, for the link bubble.
 *
 * A card element stores only `{ entityType, entityId }`, so naming it needs one
 * read. Cached because a bubble re-renders on every pan and zoom, and entries go
 * stale rather than pinning a title a user has since changed.
 */

import { notesService } from '@/services/notes-service'
import { tasksService } from '@/services/tasks-service'
import { calendarService } from '@/services/calendar-service'
import { createLogger } from '@/lib/logger'

const log = createLogger('SpatialCanvas')

export const TITLE_CACHE_LIMIT = 64
export const TITLE_CACHE_TTL_MS = 5 * 60_000

interface CachedTitle {
  pending: Promise<string | null>
  cachedAt: number
}

const cache = new Map<string, CachedTitle>()

async function fetchTitle(entityType: string, entityId: string): Promise<string | null> {
  if (entityType === 'note') return (await notesService.get(entityId))?.title ?? null
  if (entityType === 'task') return (await tasksService.get(entityId))?.title ?? null
  if (entityType === 'calendar_event') {
    return (await calendarService.getEvent(entityId))?.title ?? null
  }
  return null
}

/** A Map iterates in insertion order, so its leading keys are the least recently used. */
function evictOverflow(): void {
  for (const key of cache.keys()) {
    if (cache.size <= TITLE_CACHE_LIMIT) break
    cache.delete(key)
  }
}

export function lookupCardTitle(entityType: string, entityId: string): Promise<string | null> {
  if (!entityId) return Promise.resolve(null)
  const key = `${entityType}:${entityId}`

  const cached = cache.get(key)
  if (cached) {
    // Re-inserting counts the key as the most recently used one.
    cache.delete(key)
    if (Date.now() - cached.cachedAt < TITLE_CACHE_TTL_MS) {
      cache.set(key, cached)
      return cached.pending
    }
  }

  const entry: CachedTitle = {
    // Concurrent callers share this one request; a failed lookup is dropped so
    // the next caller retries instead of inheriting a permanent "no title".
    pending: fetchTitle(entityType, entityId).catch((err: unknown) => {
      log.error('Canvas link bubble: card title lookup failed', err)
      cache.delete(key)
      return null
    }),
    cachedAt: Date.now()
  }
  cache.set(key, entry)
  evictOverflow()
  return entry.pending
}

/** Test seam: the cache is module state, so a suite has to be able to drop it. */
export function clearCardTitleCache(): void {
  cache.clear()
}
