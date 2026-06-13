import { createInlineContentSpec } from '@blocknote/core'
import { isSameWeek, addWeeks, subWeeks } from 'date-fns'
import {
  serializeDateMentionToken,
  type DateMentionData,
  type DateMentionLead
} from '@memry/shared/date-mention'
import { formatTimeOfDay, type ClockFormat } from '@/lib/time-format'

// Notion-style inline icons (raw DOM render, so SVG markup rather than the
// React icon components). Stroke uses currentColor → inherits the pill's blue.
const CALENDAR_SVG =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M8 2v4"/><path d="M16 2v4"/><rect width="18" height="18" x="3" y="4" rx="2"/><path d="M3 10h18"/></svg>'
const ALARM_SVG =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="13" r="8"/><path d="M12 9v4l2 2"/><path d="M5 3 2 6"/><path d="m22 6-3-3"/><path d="M6.38 18.7 4 21"/><path d="M17.64 18.67 20 21"/></svg>'

function startOfDay(d: Date): number {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime()
}

// Pill prefs are pushed in from React (useDateMentionPrefs) because the inline
// content renders as raw DOM with no hook/settings access. weekStartsOn: 0 =
// Sunday, 1 = Monday. clockFormat undefined → OS-locale time (the fallback).
let prefWeekStartsOn: 0 | 1 = 1
let prefClockFormat: ClockFormat | undefined

export function setDateMentionPrefs(p: { weekStartsOn?: 0 | 1; clockFormat?: ClockFormat }): void {
  if (p.weekStartsOn !== undefined) prefWeekStartsOn = p.weekStartsOn
  if (p.clockFormat !== undefined) prefClockFormat = p.clockFormat
}

function weekdayLong(d: Date): string {
  return d.toLocaleDateString(undefined, { weekday: 'long' })
}

function absoluteDate(d: Date): string {
  const month = d.toLocaleDateString(undefined, { month: 'short' })
  return `${d.getDate()} ${month}, ${d.getFullYear()}`
}

// Notion-style relative day. Future: Today / Tomorrow / This <Weekday> /
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
}

export function formatDateMentionLabel(
  dateISO: string,
  hasTime: boolean,
  opts: DateMentionLabelOptions = {}
): string {
  const now = opts.now ?? new Date()
  const weekStartsOn = opts.weekStartsOn ?? prefWeekStartsOn
  const clockFormat = opts.clockFormat ?? prefClockFormat
  const d = new Date(dateISO)
  const day = formatRelativeDay(d, now, weekStartsOn)
  if (!hasTime) return day
  const time = clockFormat
    ? formatTimeOfDay(d, clockFormat)
    : d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })
  return `${day} ${time}`
}

export function createDateMentionContent(data: DateMentionData) {
  return {
    type: 'dateMention' as const,
    props: {
      anchorId: data.anchorId,
      dateISO: data.dateISO,
      hasTime: data.hasTime,
      remind: data.remind,
      lead: data.lead
    }
  }
}

export const DateMention = createInlineContentSpec(
  {
    type: 'dateMention',
    propSchema: {
      anchorId: { default: '' },
      dateISO: { default: '' },
      hasTime: { default: false },
      remind: { default: false },
      lead: { default: 'at' }
    },
    content: 'none'
  },
  {
    render: (inlineContent) => {
      const { anchorId, dateISO, hasTime, remind, lead } = inlineContent.props

      const dom = document.createElement('span')
      dom.className = 'date-mention'
      dom.setAttribute('data-date-mention', '')
      dom.setAttribute('data-anchor-id', anchorId)
      dom.setAttribute('data-date-iso', dateISO)
      dom.setAttribute('data-has-time', String(hasTime))
      dom.setAttribute('data-remind', String(remind))
      dom.setAttribute('data-lead', String(lead))
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
      label.textContent = formatDateMentionLabel(dateISO, hasTime)
      dom.appendChild(label)

      const icon = document.createElement('span')
      icon.className = 'date-mention-icon'
      icon.setAttribute('aria-hidden', 'true')
      icon.innerHTML = remind ? ALARM_SVG : CALENDAR_SVG
      dom.appendChild(icon)

      return { dom }
    },

    parse: (element) => {
      if (!element.hasAttribute('data-date-mention')) return undefined
      const anchorId = element.getAttribute('data-anchor-id') || ''
      const dateISO = element.getAttribute('data-date-iso') || ''
      if (!anchorId || !dateISO) return undefined
      return {
        anchorId,
        dateISO,
        hasTime: element.getAttribute('data-has-time') === 'true',
        remind: element.getAttribute('data-remind') === 'true',
        lead: (element.getAttribute('data-lead') || 'at') as DateMentionLead
      }
    },

    toExternalHTML: (inlineContent) => {
      const { anchorId, dateISO, hasTime, remind } = inlineContent.props
      const lead = inlineContent.props.lead as DateMentionLead
      const dom = document.createElement('span')
      dom.textContent = serializeDateMentionToken({ anchorId, dateISO, hasTime, remind, lead })
      return { dom }
    }
  }
)
