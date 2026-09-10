/**
 * Canvas titles, as the editor's link grammar needs them (#1983).
 *
 * A canvas is a first-class vault item in the sidebar, the Related picker and
 * the mind map, but the editor's `[[…]]` grammar only ever knew about notes:
 * typing `[[` never offered one, and a hand-typed `[[My Canvas]]` resolved to
 * nothing and was painted broken. Three surfaces need the same answer — the
 * resolver, the suggestion menu and the broken-link pass — so the lookup lives
 * here once rather than three times.
 *
 * Canvases have no title index and no `resolve-by-title` channel; the whole
 * list is one cheap IPC call (metadata rows, no scenes), so it is fetched and
 * cached for the same short window the wiki-link suggestion cache uses. A
 * canvas created or renamed a moment ago therefore becomes linkable within
 * seconds rather than instantly, which is the same freshness the note-side
 * suggestion list has always had.
 *
 * @module lib/canvas-lookup
 */

import { canvasService, type CanvasSummary } from '@/services/canvas-service'
import { createLogger } from '@/lib/logger'

const log = createLogger('Lib:CanvasLookup')

const CACHE_TTL_MS = 5000

let cache: { canvases: CanvasSummary[]; fetchedAt: number } | null = null

/** Drops the cached list, so the next lookup asks again. Tests and events. */
export function clearCanvasLookupCache(): void {
  cache = null
}

/** Every live canvas, cached briefly. Empty when the call fails — never throws. */
export async function listCanvasesCached(): Promise<CanvasSummary[]> {
  const now = Date.now()
  if (cache && now - cache.fetchedAt <= CACHE_TTL_MS) return cache.canvases

  try {
    const result = await canvasService.list()
    cache = { canvases: result.canvases, fetchedAt: now }
  } catch (error) {
    log.error('Failed to list canvases for link resolution', error)
    cache = { canvases: [], fetchedAt: now }
  }
  return cache.canvases
}

/** A canvas that has a title, which is the only kind a link can name. */
export interface TitledCanvas {
  id: string
  title: string
}

/**
 * Every canvas a link could name — the titled ones. An untitled canvas has
 * nothing for `[[…]]` to carry, so it is neither offered nor matched.
 */
export async function listTitledCanvases(): Promise<TitledCanvas[]> {
  const canvases = await listCanvasesCached()
  const titled: TitledCanvas[] = []
  for (const canvas of canvases) {
    const title = canvas.title?.trim()
    if (title) titled.push({ id: canvas.id, title })
  }
  return titled
}

/**
 * The canvas a wiki-link target names, matched on title.
 *
 * Case-insensitive, exact match, first row wins — the same reading
 * `resolveNoteByTitle` gives a note title, so `[[my canvas]]` and
 * `[[My Canvas]]` reach the same canvas. An untitled canvas has nothing to
 * name it, so it never matches.
 */
export async function resolveCanvasByTitle(title: string): Promise<TitledCanvas | null> {
  const wanted = title.trim().toLowerCase()
  if (!wanted) return null

  const canvases = await listTitledCanvases()
  return canvases.find((canvas) => canvas.title.toLowerCase() === wanted) ?? null
}
