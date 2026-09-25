/**
 * Template inputs for the `journal.json` class (spec 005-journal JP011),
 * split from `journal-cases.ts` for the line ceiling.
 */

export const TEMPLATE_RESOLUTION_CASES: ReadonlyArray<{
  name: string
  settings: { defaultTemplate: string | null; weekdayTemplates?: Record<string, string | null> }
  date: string
}> = [
  {
    name: 'weekday override',
    settings: { defaultTemplate: 'def', weekdayTemplates: { '1': 'mon' } },
    date: '2099-06-15'
  },
  {
    name: 'explicit null falls back',
    settings: { defaultTemplate: 'def', weekdayTemplates: { '1': null } },
    date: '2099-06-15'
  },
  {
    name: 'empty string falls back',
    settings: { defaultTemplate: 'def', weekdayTemplates: { '1': '' } },
    date: '2099-06-15'
  },
  {
    name: 'missing key falls back',
    settings: { defaultTemplate: 'def', weekdayTemplates: { '3': 'wed' } },
    date: '2099-06-15'
  },
  { name: 'no weekday map', settings: { defaultTemplate: 'def' }, date: '2099-06-15' },
  {
    name: 'keys outside 0..6 ignored',
    settings: {
      defaultTemplate: null,
      weekdayTemplates: { '7': 'x', '-1': 'y', mon: 'z', '01': 'w' }
    },
    date: '2099-06-15'
  },
  {
    name: 'no default',
    settings: { defaultTemplate: null, weekdayTemplates: {} },
    date: '2099-06-15'
  },
  {
    name: 'sunday',
    settings: { defaultTemplate: null, weekdayTemplates: { '0': 'sun' } },
    date: '2099-06-14'
  },
  {
    name: 'saturday',
    settings: { defaultTemplate: 'def', weekdayTemplates: { '6': 'sat' } },
    date: '2099-06-20'
  },
  {
    name: 'leap day thursday',
    settings: { defaultTemplate: null, weekdayTemplates: { '3': 'wed' } },
    date: '2096-02-29'
  },
  {
    name: 'utc-west trap date',
    settings: { defaultTemplate: null, weekdayTemplates: { '1': 'mon' } },
    date: '2026-08-17'
  }
]

export const WEEKDAY_DATES: ReadonlyArray<string> = [
  '1970-01-01',
  '2000-02-29',
  '2024-01-07',
  '2026-08-17',
  '2096-02-29',
  '2099-06-14',
  '2099-06-15',
  '2099-12-31',
  '2100-03-01'
]

export const FORMATTED = {
  longDate: 'Monday, June 15, 2099',
  time: '9:05 AM',
  dayOfWeek: 'Monday'
}

export const TEMPLATE_APPLY_CASES: ReadonlyArray<{
  name: string
  date: string
  content: string
  tags?: string[]
  properties?: Array<{ name: string; value: unknown }>
}> = [
  { name: 'no tokens', date: '2099-06-15', content: 'Plain body\n- item' },
  { name: 'title', date: '2099-06-15', content: '# {{title}}' },
  { name: 'date long', date: '2099-06-15', content: 'Today is {{date}}.' },
  { name: 'date iso pattern', date: '2099-06-15', content: '{{date:YYYY-MM-DD}}' },
  { name: 'date dotted pattern', date: '2099-06-05', content: '{{date:DD.MM.YYYY}}' },
  {
    name: 'date repeated tokens in pattern',
    date: '2099-06-05',
    content: '{{date:YYYY/MM/DD - DD}}'
  },
  { name: 'time', date: '2099-06-15', content: 'Started at {{time}}' },
  { name: 'day of week', date: '2099-06-15', content: '## {{day-of-week}} check-in' },
  {
    name: 'all tokens repeated',
    date: '2099-06-15',
    content: '{{title}} {{title}} {{date}} {{date:MM}} {{time}} {{day-of-week}} {{day-of-week}}'
  },
  {
    name: 'unknown token kept',
    date: '2099-06-15',
    content: '{{mood}} and {{ date }} and {{date:}}'
  },
  {
    name: 'tags and properties',
    date: '2099-06-15',
    content: 'Body',
    tags: ['daily', 'journal'],
    properties: [
      { name: 'mood', value: 'calm' },
      { name: 'rating', value: 4 },
      { name: 'done', value: false },
      { name: 'empty', value: null },
      { name: 'list', value: ['a', 'b'] }
    ]
  },
  {
    name: 'repeated property name, last wins',
    date: '2099-06-15',
    content: '',
    properties: [
      { name: 'mood', value: 'first' },
      { name: 'mood', value: 'second' }
    ]
  }
]
