import {
  EPOCH,
  imageHighlightUrl,
  isLiveHighlight,
  newestCreatedAt,
  renderHighlights
} from './highlights.ts'
import { headingLevel, toIsoInstant } from './text.ts'
import type { ReadwiseHighlight, SavedImages } from './types.ts'

export interface PlanAppendOptions {
  /** `last` from the section's end marker, or null when the note has no readable one. */
  last: string | null
  /** When the note was created: the floor when `last` is unusable. */
  noteCreated: string
  /** Ids of the highlights whose Readwise link is already in the note. */
  linkedIds: ReadonlySet<number>
  timeZone: string
  images?: SavedImages
}

export interface AppendPlan {
  /** List items to add before the end marker, empty when nothing is new. */
  markdown: string
  /** The `last` to write into the end marker. */
  last: string
}

/**
 * `floor` is where candidates start. `held` is where an image highlight starts
 * and what `last` is held to: without a usable `last` they differ, so a
 * highlight held back for a failed image download is not skipped for good.
 */
function floors(
  last: string | null,
  noteCreated: string,
  present: ReadwiseHighlight[]
): { floor: number; held: number } {
  const lastMs = last === null ? Number.NaN : Date.parse(last)
  if (!Number.isNaN(lastMs)) return { floor: lastMs, held: lastMs }
  const held = Date.parse(noteCreated)
  let floor = held
  for (const h of present) {
    const created = Date.parse(toIsoInstant(h.created_at) ?? '')
    if (!Number.isNaN(created) && (Number.isNaN(floor) || created + 1 > floor)) floor = created + 1
  }
  return { floor, held }
}

/**
 * What a touched section still receives (D5): the highlights created at or
 * after `last` whose id is not in the note yet. `last` sits one millisecond
 * past the newest highlight written, so the newest one a user deleted does not
 * come back. Without a usable `last` the floor is the later of the note's
 * creation and the newest highlight the note links: nothing older than what
 * the note holds returns, at the price of skipping an older highlight that was
 * never in the note. Heading highlights are never
 * appended, because the note holds no link to tell whether one is there.
 */
export function planAppend(
  highlights: ReadwiseHighlight[],
  { last, noteCreated, linkedIds, timeZone, images }: PlanAppendOptions
): AppendPlan {
  const live = highlights.filter(isLiveHighlight).filter((h) => headingLevel(h) === null)
  const present = live.filter((h) => linkedIds.has(h.id))
  const { floor, held } = floors(last, noteCreated, present)

  const fresh = live.filter((h) => {
    if (linkedIds.has(h.id)) return false
    const created = Date.parse(toIsoInstant(h.created_at) ?? '')
    const from = imageHighlightUrl(h) === null ? floor : held
    return Number.isNaN(created) || Number.isNaN(from) || created >= from
  })

  const { markdown, rendered, missing } = renderHighlights(fresh, {
    timeZone,
    images: images ?? new Map()
  })
  const newLast = newestCreatedAt(
    [...rendered, ...present],
    missing,
    Number.isNaN(held) ? EPOCH : new Date(held).toISOString()
  )
  return { markdown, last: newLast }
}
