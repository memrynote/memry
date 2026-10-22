import { EPOCH, isLiveHighlight, newestCreatedAt, renderHighlights } from './highlights.ts'
import { headingLevel, toIsoInstant } from './text.ts'
import type { ReadwiseHighlight, SavedImages } from './types.ts'

export interface PlanAppendOptions {
  /** `last` from the section's end marker. */
  last: string
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
 * What a touched section still receives (D5): the highlights created at or
 * after `last` whose id is not in the note yet. Heading highlights are never
 * appended, because the note holds no link to tell whether one is there.
 */
export function planAppend(
  highlights: ReadwiseHighlight[],
  { last, linkedIds, timeZone, images }: PlanAppendOptions
): AppendPlan {
  const lastMs = Date.parse(last)
  const live = highlights.filter(isLiveHighlight).filter((h) => headingLevel(h) === null)

  const fresh = live.filter((h) => {
    if (linkedIds.has(h.id)) return false
    const created = Date.parse(toIsoInstant(h.created_at) ?? '')
    return Number.isNaN(created) || Number.isNaN(lastMs) || created >= lastMs
  })

  const { markdown, rendered, missing } = renderHighlights(fresh, {
    timeZone,
    images: images ?? new Map()
  })
  const present = live.filter((h) => linkedIds.has(h.id))
  const newLast = newestCreatedAt(
    [...rendered, ...present],
    missing,
    Number.isNaN(lastMs) ? EPOCH : new Date(lastMs).toISOString()
  )
  return { markdown, last: newLast }
}
