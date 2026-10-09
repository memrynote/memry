/**
 * Template offers a note is waiting on: a tag with a template was added to a
 * note that already had text, so main offered the template instead of
 * applying it. Device-local by design (decisions.md: per device is fine);
 * adding or dismissing the offer clears it for this note.
 */
import { useCallback, useSyncExternalStore } from 'react'
import { createLogger } from '@/lib/logger'

const log = createLogger('TagTemplateOffers')

const STORAGE_PREFIX = 'memry:tag-template-offers:'
const listeners = new Set<() => void>()
const EMPTY: readonly string[] = []
const cache = new Map<string, readonly string[]>()

function read(noteId: string): readonly string[] {
  const cached = cache.get(noteId)
  if (cached) return cached
  let tags: readonly string[] = EMPTY
  try {
    const raw = localStorage.getItem(STORAGE_PREFIX + noteId)
    const parsed: unknown = raw ? JSON.parse(raw) : null
    if (Array.isArray(parsed)) tags = parsed.filter((t): t is string => typeof t === 'string')
  } catch (error) {
    log.warn('Failed to read template offers', error)
  }
  cache.set(noteId, tags)
  return tags
}

function write(noteId: string, tags: readonly string[]): void {
  cache.set(noteId, tags.length > 0 ? tags : EMPTY)
  try {
    if (tags.length > 0) localStorage.setItem(STORAGE_PREFIX + noteId, JSON.stringify(tags))
    else localStorage.removeItem(STORAGE_PREFIX + noteId)
  } catch (error) {
    log.warn('Failed to persist template offers', error)
  }
  for (const listener of listeners) listener()
}

export const templateOffers = {
  pending: read,
  mark(noteId: string, tag: string): void {
    const key = tag.toLowerCase()
    const current = read(noteId)
    if (!current.includes(key)) write(noteId, [...current, key])
  },
  resolve(noteId: string, tag: string): void {
    const key = tag.toLowerCase()
    const current = read(noteId)
    if (current.includes(key))
      write(
        noteId,
        current.filter((t) => t !== key)
      )
  }
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

/** Lowercase tags whose template this note is offered. */
export function usePendingTemplateOffers(noteId: string | null): readonly string[] {
  const getSnapshot = useCallback(() => (noteId ? read(noteId) : EMPTY), [noteId])
  return useSyncExternalStore(subscribe, getSnapshot)
}
