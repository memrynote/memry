/**
 * Class: journal rules (`journal.json`) — spec 005-journal D3, D4, D6.
 *
 * Preview extraction, word count, activity level, the streak walk, month and
 * year arithmetic, template resolution per weekday and template token
 * substitution, recorded from the real `@memry/domain-notes/journal` functions
 * desktop runs (and `countWords` / `calculateActivityLevel` from
 * `journal-api`). The generator enumerates inputs and records outputs; it
 * never predicts them.
 *
 * Determinism: every clock-dependent function receives an explicit `today`,
 * and the locale strings a shell formats are fixed inputs (`FORMATTED`).
 * Lengths are JavaScript string lengths (UTF-16 code units).
 */
import {
  applyJournalTemplate,
  averageActivityLevel,
  computeJournalStreak,
  extractJournalPreview,
  heatmapDay,
  monthActivity,
  monthDays,
  orderedWeekdays,
  planJournalDayApply,
  planJournalDayMerge,
  resolveJournalTemplateId,
  weekdayOf,
  yearMonthStats
} from '../../../domain-notes/src/journal/index.ts'
import { calculateActivityLevel, countWords } from '../../src/journal-api'
import {
  ACTIVITY_COUNTS,
  MONTH_ACTIVITY_CASES,
  MONTH_DAY_CASES,
  PREVIEW_CASES,
  STREAK_CASES,
  WORD_TEXTS,
  YEAR_STATS_CASES
} from './journal-cases'
import {
  FORMATTED,
  TEMPLATE_APPLY_CASES,
  TEMPLATE_RESOLUTION_CASES,
  WEEKDAY_DATES
} from './journal-template-cases'
import { meta } from './shared'

const D = '2026-06-09'
const LIVE = { deleted: false, bodyPulled: true, hasBody: true, dayDeleted: false, clocked: true }
const DAY_MERGE_CASES: ReadonlyArray<{
  name: string
  state: Parameters<typeof planJournalDayMerge>[0]
}> = [
  { name: 'live, body merged', state: LIVE },
  { name: 'live, body not fully pulled', state: { ...LIVE, bodyPulled: false } },
  { name: 'live, no body and no text', state: { ...LIVE, hasBody: false } },
  { name: 'live, never synced (empty clock)', state: { ...LIVE, clocked: false } },
  { name: 'live, day deleted here', state: { ...LIVE, dayDeleted: true } },
  {
    name: 'live, no body and no text, day deleted here',
    state: { ...LIVE, hasBody: false, dayDeleted: true }
  },
  { name: 'deleted, body held here', state: { ...LIVE, deleted: true } },
  {
    name: 'deleted, nothing held here',
    state: { ...LIVE, deleted: true, hasBody: false }
  },
  {
    name: 'deleted, day deleted here',
    state: { ...LIVE, deleted: true, dayDeleted: true }
  }
]
const DAY_IDENTITY_CASES: ReadonlyArray<{
  name: string
  incomingId: string
  date: string
  holderId: string | null
}> = [
  { name: 'canonical, day empty', incomingId: `j${D}`, date: D, holderId: null },
  { name: 'canonical, held by itself', incomingId: `j${D}`, date: D, holderId: `j${D}` },
  {
    name: 'canonical, held by a foreign row',
    incomingId: `j${D}`,
    date: D,
    holderId: 'vcpzueguep8y'
  },
  { name: 'foreign, day empty', incomingId: 'vcpzueguep8y', date: D, holderId: null },
  { name: 'foreign, held by canonical', incomingId: 'vcpzueguep8y', date: D, holderId: `j${D}` },
  {
    name: 'foreign, held by itself',
    incomingId: 'vcpzueguep8y',
    date: D,
    holderId: 'vcpzueguep8y'
  },
  {
    name: 'foreign, held by another foreign',
    incomingId: 'vcpzueguep8y',
    date: D,
    holderId: 'wxudm2oo4rci'
  },
  {
    name: 'canonical of another day is foreign',
    incomingId: 'j2026-06-08',
    date: D,
    holderId: `j${D}`
  }
]

export function buildJournal(): Record<string, unknown> {
  return {
    meta: meta({
      spec: '005-ios-journal-parity',
      source: '@memry/domain-notes/journal, @memry/contracts/journal-api',
      lengths: 'UTF-16 code units (JavaScript string length)'
    }),
    preview: PREVIEW_CASES.map((c) => ({
      name: c.name,
      content: c.content,
      maxLength: c.maxLength ?? 100,
      expected: extractJournalPreview(c.content, c.maxLength ?? 100)
    })),
    words: WORD_TEXTS.map((text) => ({
      text,
      words: countWords(text),
      characters: text.length,
      level: calculateActivityLevel(text.length)
    })),
    activity: ACTIVITY_COUNTS.map((characterCount) => ({
      characterCount,
      level: calculateActivityLevel(characterCount)
    })),
    streak: STREAK_CASES.map((c) => ({
      name: c.name,
      dates: c.dates,
      today: c.today,
      expected: computeJournalStreak(c.dates, c.today)
    })),
    monthDays: MONTH_DAY_CASES.map((c) => ({
      year: c.year,
      month: c.month,
      today: c.today,
      expected: monthDays(c.year, c.month, c.today)
    })),
    monthActivity: MONTH_ACTIVITY_CASES.map((c) => {
      const heatmap = c.days.map(([date, characterCount]) => heatmapDay(date, characterCount))
      return { name: c.name, year: c.year, heatmap, expected: monthActivity(c.year, heatmap) }
    }),
    yearStats: YEAR_STATS_CASES.map((c) => {
      const rows = c.rows.map(([date, wordCount, characterCount]) => ({
        date,
        wordCount,
        characterCount
      }))
      return {
        name: c.name,
        rows,
        expected: yearMonthStats(rows),
        averageLevel: averageActivityLevel(rows.map((row) => row.characterCount))
      }
    }),
    dayMerge: DAY_MERGE_CASES.map((c) => ({
      name: c.name,
      state: c.state,
      expected: planJournalDayMerge(c.state)
    })),
    dayIdentity: DAY_IDENTITY_CASES.map((c) => ({
      name: c.name,
      incomingId: c.incomingId,
      date: c.date,
      holderId: c.holderId,
      expected: planJournalDayApply(c.incomingId, c.date, c.holderId)
    })),
    weekday: WEEKDAY_DATES.map((date) => ({ date, weekday: weekdayOf(date) })),
    orderedWeekdays: ([0, 1] as const).map((weekStartsOn) => ({
      weekStartsOn,
      expected: orderedWeekdays(weekStartsOn)
    })),
    templateResolution: TEMPLATE_RESOLUTION_CASES.map((c) => ({
      name: c.name,
      settings: c.settings,
      date: c.date,
      expected: resolveJournalTemplateId(c.settings, c.date)
    })),
    templateApply: TEMPLATE_APPLY_CASES.map((c) => {
      const template = { content: c.content, tags: c.tags ?? [], properties: c.properties ?? [] }
      return {
        name: c.name,
        date: c.date,
        formatted: FORMATTED,
        template,
        expected: applyJournalTemplate(template, c.date, FORMATTED)
      }
    })
  }
}
