import type { DragEndEvent } from '@dnd-kit/core'
import { SNAP_MINUTES } from './time-grid-constants'

const MINUTES_IN_DAY = 1440

/**
 * Minutes since midnight for a pixel offset from the top of a day column,
 * snapped to `step` and clamped so a slot of `step` still fits in the day.
 */
export function minutesFromOffset(offsetY: number, hourHeight: number, step: number): number {
  const snapped = Math.round(((offsetY / hourHeight) * 60) / step) * step
  return Math.max(0, Math.min(snapped, MINUTES_IN_DAY - step))
}

export function formatClockMinutes(minutes: number): string {
  const hours = Math.floor(minutes / 60)
  return `${String(hours).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`
}

export function timeFromOffset(offsetY: number, hourHeight: number, step = SNAP_MINUTES): string {
  return formatClockMinutes(minutesFromOffset(offsetY, hourHeight, step))
}

export interface DateDropOptions {
  /** Omit to keep the task's current time; null clears it; 'HH:MM' sets it. */
  dueTime?: string | null
  /** Duration given to a task that had no time before this drop. */
  durationIfUntimed?: number
}

/**
 * The droppable data a timed column registers with `timeBehavior: 'slot'`.
 * `getSlotOffsetY` lets a column inside its own scroll container report the
 * pointer offset from live layout, which dnd-kit's cached rects miss while the
 * container auto-scrolls.
 */
export interface SlotDropData {
  timeBehavior: 'slot'
  hourHeight: number
  snapMinutes?: number
  durationIfUntimed?: number
  getSlotOffsetY?: () => number | null
}

function isSlotDropData(
  data: Record<string, unknown> | undefined
): data is Record<string, unknown> & SlotDropData {
  return data?.timeBehavior === 'slot' && typeof data.hourHeight === 'number'
}

export function slotOffsetY(
  data: SlotDropData,
  event: Pick<DragEndEvent, 'active' | 'over'>
): number | null {
  if (data.getSlotOffsetY) return data.getSlotOffsetY()
  const overTop = event.over?.rect.top
  const activeTop = event.active.rect.current.translated?.top
  if (overTop === undefined || activeTop === undefined) return null
  return activeTop - overTop
}

/**
 * Month cells preserve the task's time (no key), all-day cells clear it
 * (dueTime: null), timed columns derive it from where the chip landed.
 */
export function resolveDropOptions(
  overData: Record<string, unknown> | undefined,
  event: Pick<DragEndEvent, 'active' | 'over'>
): DateDropOptions | undefined {
  if (isSlotDropData(overData)) {
    const offset = slotOffsetY(overData, event)
    if (offset === null) return undefined
    return {
      dueTime: timeFromOffset(offset, overData.hourHeight, overData.snapMinutes),
      ...(overData.durationIfUntimed ? { durationIfUntimed: overData.durationIfUntimed } : {})
    }
  }
  if (overData && 'dueTime' in overData) {
    return { dueTime: overData.dueTime as string | null }
  }
  return undefined
}
