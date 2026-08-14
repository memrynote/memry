import { createDateMentionSpec } from '@memry/editor-schema/inline'
import { isSameWeek, addWeeks, subWeeks } from 'date-fns'
import {
  type DateMentionData,
  type DateMentionDateFormat,
  type DateMentionTimeFormat,
  type RemindOffset
} from '@memry/shared/date-mention'
import { formatTimeOfDay, type ClockFormat } from '@/lib/time-format'
import { getWeekStartsOn } from '@/lib/week-start'

// Inline alarm icon (raw DOM render, so SVG markup rather than the
// React icon component). Only reminder pills show it; a date-only pill renders
// label-only. Stroke uses currentColor → inherits the pill's blue.
const ALARM_SVG =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="13" r="8"/><path d="M12 9v4l2 2"/><path d="M5 3 2 6"/><path d="m22 6-3-3"/><path d="M6.38 18.7 4 21"/><path d="M17.64 18.67 20 21"/></svg>'

function startOfDay(d: Date): number {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime()
}

// Clock format is pushed in from React (useDateMentionPrefs) because the inline
// content renders as raw DOM with no hook/settings access. clockFormat undefined
// → OS-locale time (the fallback). Week start comes from the global cache
// (getWeekStartsOn): 0 = Sunday, 1 = Monday.
let prefClockFormat: ClockFormat | undefined

export function setDateMentionPrefs(p: { clockFormat?: ClockFormat }): void {
  if (p.clockFormat !== undefined) prefClockFormat = p.clockFormat
}

function weekdayLong(d: Date): string {
  return d.toLocaleDateString(undefined, { weekday: 'long' })
}

function absoluteDate(d: Date): string {
  const month = d.toLocaleDateString(undefined, { month: 'short' })
  return `${d.getDate()} ${month}, ${d.getFullYear()}`
}

// Relative day. Future: Today / Tomorrow / This <Weekday> /
// Next <Weekday>. Past mirrors it: Yesterday / bare weekday earlier this week /
// Last <Weekday>. Anything further out falls back to an absolute date.
function formatRelativeDay(d: Date, now: Date, weekStartsOn: 0 | 1): string {
  const diff = Math.round((startOfDay(d) - startOfDay(now)) / 86_400_000)
  if (diff === 0) return 'Today'
  if (diff === 1) return 'Tomorrow'
  if (diff === -1) return 'Yesterday'
  const wk = { weekStartsOn }
  if (isSameWeek(d, now, wk)) return diff >= 2 ? `This ${weekdayLong(d)}` : weekdayLong(d)
  if (isSameWeek(d, addWeeks(now, 1), wk)) return `Next ${weekdayLong(d)}`
  if (isSameWeek(d, subWeeks(now, 1), wk)) return `Last ${weekdayLong(d)}`
  return absoluteDate(d)
}

export interface DateMentionLabelOptions {
  now?: Date
  weekStartsOn?: 0 | 1
  clockFormat?: ClockFormat
  dateFormat?: DateMentionDateFormat
  timeFormat?: DateMentionTimeFormat
}

function formatTime(d: Date, clockFormat: ClockFormat | undefined): string {
  return clockFormat
    ? formatTimeOfDay(d, clockFormat)
    : d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })
}

export function formatDateMentionLabel(
  dateISO: string,
  hasTime: boolean,
  opts: DateMentionLabelOptions = {}
): string {
  const now = opts.now ?? new Date()
  const weekStartsOn = opts.weekStartsOn ?? getWeekStartsOn()
  const systemClock = opts.clockFormat ?? prefClockFormat
  // A per-block 12h/24h override wins; 'system' (and unset) inherit the setting.
  const clockFormat: ClockFormat | undefined =
    opts.timeFormat === '12h' || opts.timeFormat === '24h' ? opts.timeFormat : systemClock
  const dateFormat = opts.dateFormat ?? 'relative'
  const d = new Date(dateISO)
  const day = dateFormat === 'full' ? absoluteDate(d) : formatRelativeDay(d, now, weekStartsOn)
  if (!hasTime) return day
  return `${day} ${formatTime(d, clockFormat)}`
}

// Builds the raw pill DOM. Extracted from the inline-content `render` so the
// icon/label behavior is unit-testable (BlockNote wraps the spec's render in a
// ProseMirror node-view signature). A reminder (`remind !== 'none'`) shows the
// alarm icon and reads as blue (see base.css); a date-only pill is label-only
// and muted.
export function createDateMentionPillDom(props: {
  anchorId: string
  dateISO: string
  hasTime: boolean
  dateFormat: DateMentionDateFormat
  remind: RemindOffset
  timeFormat: DateMentionTimeFormat
}): HTMLSpanElement {
  const { anchorId, dateISO, hasTime, dateFormat, remind, timeFormat } = props

  const dom = document.createElement('span')
  dom.className = 'date-mention'
  dom.setAttribute('data-date-mention', '')
  dom.setAttribute('data-anchor-id', anchorId)
  dom.setAttribute('data-date-iso', dateISO)
  dom.setAttribute('data-has-time', String(hasTime))
  dom.setAttribute('data-date-format', String(dateFormat))
  dom.setAttribute('data-remind', String(remind))
  dom.setAttribute('data-time-format', String(timeFormat))
  dom.setAttribute('contenteditable', 'false')
  dom.setAttribute('role', 'button')
  dom.setAttribute('tabindex', '0')

  const at = document.createElement('span')
  at.className = 'date-mention-at'
  at.textContent = '@'
  at.setAttribute('aria-hidden', 'true')
  dom.appendChild(at)

  const label = document.createElement('span')
  label.className = 'date-mention-label'
  label.textContent = formatDateMentionLabel(dateISO, hasTime, { dateFormat, timeFormat })
  dom.appendChild(label)

  if (remind !== 'none') {
    const icon = document.createElement('span')
    icon.className = 'date-mention-icon'
    icon.setAttribute('aria-hidden', 'true')
    icon.innerHTML = ALARM_SVG
    dom.appendChild(icon)
  }

  return dom
}

export function createDateMentionContent(data: DateMentionData) {
  return {
    type: 'dateMention' as const,
    props: {
      anchorId: data.anchorId,
      dateISO: data.dateISO,
      hasTime: data.hasTime,
      dateFormat: data.dateFormat,
      remind: data.remind,
      timeFormat: data.timeFormat
    }
  }
}

// Presentation only — the pill formats against the user's week-start and clock
// settings, which are renderer state. The config, `parse` and `toExternalHTML`
// live in @memry/editor-schema so the main process registers the same node.
export const DateMention = createDateMentionSpec((inlineContent) => {
  const { anchorId, dateISO, hasTime, dateFormat, remind, timeFormat } = inlineContent.props
  const dom = createDateMentionPillDom({
    anchorId,
    dateISO,
    hasTime,
    dateFormat: dateFormat as DateMentionDateFormat,
    remind: remind as RemindOffset,
    timeFormat: timeFormat as DateMentionTimeFormat
  })
  return { dom }
})
