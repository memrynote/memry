/**
 * Pure candidate + geometry helpers for the canvas "Add card" picker.
 *
 * React- and Excalidraw-free (types only), mirroring canvas-cards.ts, so the
 * merge/dedup/scroll logic unit-tests without either library.
 */

import type { CanvasEntityType } from '@memry/contracts/canvas-api'
import type { CalendarProjectionItem } from '@memry/contracts/calendar-api'
import type { SearchResultItem } from '@memry/contracts/search-api'
import { formatEventTime } from './canvas-cards'

/** How far either side of today the picker looks for events. */
export const EVENT_RANGE_DAYS = 90

export interface AddCardCandidate {
  entityType: CanvasEntityType
  entityId: string
  title: string
  /** Secondary line: note path, project name, or event start. */
  subtitle: string
  /** True when this entity already has a card on the open canvas. */
  onCanvas: boolean
}

export interface AddCardGroups {
  note: AddCardCandidate[]
  task: AddCardCandidate[]
  calendar_event: AddCardCandidate[]
}

/** Stable identity for a candidate, matching extractEntityRefs' key shape. */
export function candidateKey(entityType: CanvasEntityType, entityId: string): string {
  return `${entityType}:${entityId}`
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
        subtitle: result.metadata.path,
        onCanvas: false
      })
    } else if (result.metadata.type === 'task') {
      out.push({
        entityType: 'task',
        entityId: result.id,
        title: result.title,
        subtitle: result.metadata.projectName,
        onCanvas: false
      })
    }
  }
  return out
}

/**
 * Memry events from a calendar range projection, filtered by title.
 * Tasks, reminders, notes and external Google events also project onto the
 * calendar, but only `sourceType: 'event'` is a `calendar_event` entity.
 *
 * A blank query returns no events: the design spec's one-click "Create new
 * note" path depends on an empty picker leaving the create row highlighted,
 * and every event in the ±90-day window would otherwise flood in unfiltered.
 */
export function candidatesFromProjections(
  items: readonly CalendarProjectionItem[],
  query: string,
  allDayLabel: string
): AddCardCandidate[] {
  const needle = query.trim().toLowerCase()
  if (!needle) {
    return []
  }
  const earliest = new Map<string, CalendarProjectionItem>()
  for (const item of items) {
    if (item.sourceType !== 'event') {
      continue
    }
    if (!item.title.toLowerCase().includes(needle)) {
      continue
    }
    // A recurring event yields one projection per occurrence; a card
    // references the event itself, so collapse to the earliest.
    const seen = earliest.get(item.sourceId)
    if (!seen || item.startAt < seen.startAt) {
      earliest.set(item.sourceId, item)
    }
  }
  return [...earliest.values()]
    .sort((a, b) => a.startAt.localeCompare(b.startAt))
    .map((item) => ({
      entityType: 'calendar_event' as const,
      entityId: item.sourceId,
      title: item.title,
      subtitle: formatEventTime(item.startAt, item.isAllDay, allDayLabel),
      onCanvas: false
    }))
}

/** Candidate keys for every entity already carded on the open canvas. */
export function onCanvasKeys(
  cards: readonly { entityType: CanvasEntityType; entityId: string }[]
): Set<string> {
  return new Set(cards.map((card) => candidateKey(card.entityType, card.entityId)))
}

export function markOnCanvas(
  candidates: readonly AddCardCandidate[],
  keys: ReadonlySet<string>
): AddCardCandidate[] {
  return candidates.map((candidate) => ({
    ...candidate,
    onCanvas: keys.has(candidateKey(candidate.entityType, candidate.entityId))
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

/** The bounded event window the picker queries. `now` is injected for tests. */
export function eventRange(now: number): { startAt: string; endAt: string } {
  const span = EVENT_RANGE_DAYS * 24 * 60 * 60 * 1000
  return {
    startAt: new Date(now - span).toISOString(),
    endAt: new Date(now + span).toISOString()
  }
}
