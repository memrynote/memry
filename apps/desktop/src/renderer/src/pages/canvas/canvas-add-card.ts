/**
 * Pure candidate + geometry helpers for the canvas "Add card" picker.
 *
 * React- and Excalidraw-free (types only), mirroring canvas-cards.ts, so the
 * merge/dedup/scroll logic unit-tests without either library.
 */

import type { CanvasEntityType } from '@memry/contracts/canvas-api'
import type { CalendarEventSearchItem } from '@memry/contracts/calendar-api'
import type { SearchResultItem } from '@memry/contracts/search-api'
import { parseDueDate } from '@/lib/task-utils'
import { entityKey } from './canvas-cards'

/**
 * Everything a picker row needs to render its entity the way the rest of the
 * app renders it. Carried raw (not pre-formatted into one subtitle string) so
 * the row can show an icon, a status and a date as separate affordances.
 */
export type AddCardDetail =
  | {
      type: 'note'
      /** Emoji or hugeicon token from the note itself; null falls back to the type icon. */
      emoji: string | null
      path: string
      createdAt: string | null
    }
  | {
      type: 'task'
      projectName: string
      projectColor: string
      statusName: string | null
      /** 0–4, as stored. The row maps it to the shared priorityConfig. */
      priority: number
      dueDate: string | null
      completed: boolean
      createdAt: string | null
    }
  | { type: 'calendar_event'; startAt: string; isAllDay: boolean }

export interface AddCardCandidate {
  entityType: CanvasEntityType
  entityId: string
  title: string
  detail: AddCardDetail
  /** True when this entity already has a card on the open canvas. */
  onCanvas: boolean
}

export interface AddCardGroups {
  note: AddCardCandidate[]
  task: AddCardCandidate[]
  calendar_event: AddCardCandidate[]
}

/**
 * Notes and tasks from a quick-search response. Journal and inbox hits are
 * dropped — neither is a CanvasEntityType.
 */
export function candidatesFromSearch(results: readonly SearchResultItem[]): AddCardCandidate[] {
  const out: AddCardCandidate[] = []
  for (const result of results) {
    if (result.metadata.type === 'note') {
      // A "note" hit can be a filed binary (pdf/image/audio/video — see #800).
      // Canvas note cards render markdown previews and open the markdown
      // editor, so a binary is not placeable. The picker's quick-search call
      // already asks for markdown only (#874); this is the backstop.
      if ((result.metadata.fileType ?? 'markdown') !== 'markdown') {
        continue
      }
      out.push({
        entityType: 'note',
        entityId: result.id,
        title: result.title,
        detail: {
          type: 'note',
          emoji: result.metadata.emoji ?? null,
          path: result.metadata.path,
          createdAt: result.metadata.createdAt ?? null
        },
        onCanvas: false
      })
    } else if (result.metadata.type === 'task') {
      out.push({
        entityType: 'task',
        entityId: result.id,
        title: result.title,
        detail: {
          type: 'task',
          projectName: result.metadata.projectName,
          projectColor: result.metadata.projectColor,
          statusName: result.metadata.statusName,
          priority: result.metadata.priority,
          dueDate: result.metadata.dueDate,
          completed: result.metadata.completedAt !== null,
          createdAt: result.metadata.createdAt ?? null
        },
        onCanvas: false
      })
    }
  }
  return out
}

/** Candidate keys for every entity already carded on the open canvas. */
export function onCanvasKeys(
  cards: readonly { entityType: CanvasEntityType; entityId: string }[]
): Set<string> {
  return new Set(cards.map((card) => entityKey(card.entityType, card.entityId)))
}

export function markOnCanvas(
  candidates: readonly AddCardCandidate[],
  keys: ReadonlySet<string>
): AddCardCandidate[] {
  return candidates.map((candidate) => ({
    ...candidate,
    onCanvas: keys.has(entityKey(candidate.entityType, candidate.entityId))
  }))
}

export function groupCandidates(candidates: readonly AddCardCandidate[]): AddCardGroups {
  const groups: AddCardGroups = { note: [], task: [], calendar_event: [] }
  for (const candidate of candidates) {
    groups[candidate.entityType].push(candidate)
  }
  return groups
}

/**
 * Scroll offsets that center the viewport on a card. Inverts
 * viewportSceneRect: the viewport centre in scene units is
 * `-scrollX + width / (2 * zoom)`, which must equal the card centre.
 */
export function revealScroll(
  card: { x: number; y: number; width: number; height: number },
  container: { width: number; height: number },
  zoom: number
): { scrollX: number; scrollY: number } {
  const z = zoom || 1
  return {
    scrollX: container.width / (2 * z) - (card.x + card.width / 2),
    scrollY: container.height / (2 * z) - (card.y + card.height / 2)
  }
}

/**
 * Events from `calendar:search-events`. Main already filtered by title,
 * excluded archived rows and ordered by distance from now (#869), so this is a
 * pure mapping — no client-side filter, no occurrence dedup (one row per event).
 */
export function candidatesFromEvents(
  items: readonly CalendarEventSearchItem[]
): AddCardCandidate[] {
  return items.map((item) => ({
    entityType: 'calendar_event' as const,
    entityId: item.id,
    title: item.title,
    detail: { type: 'calendar_event' as const, startAt: item.startAt, isAllDay: item.isAllDay },
    onCanvas: false
  }))
}

/**
 * "Jul 2" for dates in the current year, "Jul 2, 2024" otherwise — an undated
 * "Jul 2" three years old reads as recent, which is exactly backwards.
 */
function formatDate(parsed: Date, now: Date): string | null {
  if (Number.isNaN(parsed.getTime())) return null
  return parsed.toLocaleDateString(
    undefined,
    parsed.getFullYear() === now.getFullYear()
      ? { month: 'short', day: 'numeric' }
      : { month: 'short', day: 'numeric', year: 'numeric' }
  )
}

/** Creation timestamps, which arrive as full datetimes. */
export function formatShortDate(
  value: string | null | undefined,
  now: Date = new Date()
): string | null {
  return value ? formatDate(new Date(value), now) : null
}

/**
 * Due dates are date-only strings; `new Date('2026-07-10')` parses as UTC and
 * renders as the 9th west of Greenwich, so they go through parseDueDate.
 */
export function formatDueDate(value: string | null, now: Date = new Date()): string | null {
  return value ? formatDate(parseDueDate(value), now) : null
}
