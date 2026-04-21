import type { CalendarProjectionVisualType } from '@/services/calendar-service'

import { toLocalDateKey } from './date-utils'
import { VISUAL_TYPE_META, VISUAL_TYPE_ORDER } from './visual-type-meta'

const MAX_DOTS_PER_DAY = 3

export interface DayDotsInput {
  visualType: CalendarProjectionVisualType
  startAt: string
}

interface RankedItem {
  visualType: CalendarProjectionVisualType
  intraTypeRank: number
}

function rankItemsWithinTypes(bucket: readonly DayDotsInput[]): RankedItem[] {
  const seenCount = new Map<CalendarProjectionVisualType, number>()
  return bucket.map((entry) => {
    const intraTypeRank = seenCount.get(entry.visualType) ?? 0
    seenCount.set(entry.visualType, intraTypeRank + 1)
    return { visualType: entry.visualType, intraTypeRank }
  })
}

function pickDotsForBucket(bucket: readonly DayDotsInput[]): string[] {
  const ranked = rankItemsWithinTypes(bucket)
  ranked.sort((a, b) => {
    if (a.intraTypeRank !== b.intraTypeRank) return a.intraTypeRank - b.intraTypeRank
    return VISUAL_TYPE_ORDER.indexOf(a.visualType) - VISUAL_TYPE_ORDER.indexOf(b.visualType)
  })
  return ranked
    .slice(0, MAX_DOTS_PER_DAY)
    .map((entry) => VISUAL_TYPE_META[entry.visualType].dotColor)
}

export function buildDayDots(items: readonly DayDotsInput[]): Record<string, string[]> {
  if (items.length === 0) return {}

  const bucketed: Record<string, DayDotsInput[]> = {}
  for (const entry of items) {
    const key = toLocalDateKey(entry.startAt)
    const existing = bucketed[key]
    bucketed[key] = existing ? [...existing, entry] : [entry]
  }

  const result: Record<string, string[]> = {}
  for (const [key, bucket] of Object.entries(bucketed)) {
    result[key] = pickDotsForBucket(bucket)
  }

  return result
}
