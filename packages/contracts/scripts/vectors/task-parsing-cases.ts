/**
 * Inputs for the `task-parsing` class. Inputs only: every expected value is
 * recorded from `@memry/domain-tasks/parsing` by `task-parsing.ts`.
 */

/** Local wall-clock instants the cases are evaluated at (TZ is pinned to UTC). */
export const NOWS = {
  /** Wednesday, mid-month, mid-week. */
  wednesday: '2026-01-14T12:00:00',
  /** A Sunday morning: week boundaries and "next <weekday>". */
  sunday: '2026-01-18T09:00:00',
  /** A Saturday: "this weekend" is today. */
  saturday: '2026-01-17T10:00:00',
  /** A Monday: "next week" moves a full week. */
  monday: '2026-01-19T08:00:00',
  /** Month end: month rollover, "25th" next month. */
  monthEnd: '2026-01-31T18:00:00',
  /** Year end: dates that have passed roll into next year. */
  yearEnd: '2026-12-31T23:30:00',
  /** Leap day. */
  leapDay: '2028-02-29T08:00:00'
} as const

export type NowKey = keyof typeof NOWS

export const NATURAL_DATE_INPUTS: readonly string[] = [
  // relative
  'today',
  'Today',
  '  TOMORROW  ',
  'tmrw',
  'tmr',
  'yesterday',
  'next week',
  'last week',
  'next month',
  'last month',
  'this weekend',
  'weekend',
  // in N units
  'in 3 days',
  'in 1 day',
  'in 2 weeks',
  'in 1 month',
  'in 13 months',
  'in 0 days',
  'in 99999999 days',
  'in 3 years',
  // weekdays
  'monday',
  'wednesday',
  'friday',
  'sunday',
  'next friday',
  'next monday',
  'next wednesday',
  'this saturday',
  'this wednesday',
  'last monday',
  'last wednesday',
  'last sunday',
  // month + day
  'dec 25',
  'december 25',
  'jan 1',
  'jan 14',
  'jan 13',
  'feb 29',
  'feb 30',
  'feb 31',
  'sept 3',
  'sep 3rd',
  'may 17',
  'june 1st',
  '25 dec',
  '25th december',
  '1st jan',
  '31 apr',
  // numeric
  '12/25',
  '12-25',
  '1/14',
  '1/13',
  '12/25/2024',
  '12/25/24',
  '12/25/49',
  '12/25/50',
  '2/29/2027',
  '13/1',
  '0/5',
  '12/32',
  '12/25/10000',
  // ordinals
  '25th',
  '1st',
  '14th',
  '13th',
  '31st',
  '32nd',
  // times
  'tomorrow at 3pm',
  'tomorrow 3pm',
  'tomorrow 3:30pm',
  'tomorrow at 3:30 PM',
  'tomorrow 15:00',
  'tomorrow at 14pm',
  'tomorrow 14:30pm',
  'tomorrow 12am',
  'tomorrow 12pm',
  'tomorrow 0:05',
  'tomorrow 24:00',
  'tomorrow 13am',
  'tomorrow 3:60pm',
  'next friday 2:30pm',
  'dec 25 at 9am',
  '3pm',
  'at 3pm',
  // rejects
  '',
  '   ',
  'someday',
  'next',
  'in days',
  'mon',
  'tomorrow foo',
  'the 25th'
]

export const REPEAT_PHRASES: readonly string[] = [
  'every day',
  'every 3 days',
  'every other day',
  'every weekday',
  'every weekdays',
  'every weekend',
  'every weekends',
  'every monday',
  'EVERY Fri',
  'every mon and thu',
  'every mon, wed, fri',
  'every other tuesday',
  'every 2 mondays',
  'every week',
  'every 2 weeks',
  'every month',
  'every 3 months',
  'every year',
  'every other year',
  'every  2   weeks',
  'every tues and thurs',
  'every sat sun',
  // rejects
  'every',
  'every door',
  'every other',
  'every 0 days',
  'every 1000 days',
  'every -1 days',
  'every monday and door',
  'each day',
  'daily'
]

export const REPEAT_FIND_INPUTS: readonly string[] = [
  'water plants every 2 weeks at noon',
  'standup every weekday',
  'every door is open',
  'every door every day',
  'Every Monday review',
  'pay rent every month',
  'no repeat here',
  'every mon, wed, fri gym and more words after'
]

export interface QuickAddCase {
  input: string
  now: NowKey
}

export const QUICK_ADD_PROJECTS = [
  { id: 'inbox', name: 'Inbox', isArchived: false },
  { id: 'p-work', name: 'Work', isArchived: false },
  { id: 'p-alpha', name: 'Project Alpha', isArchived: false },
  { id: 'p-personal', name: 'Personal', isArchived: false },
  { id: 'p-old', name: 'Old Stuff', isArchived: true }
] as const

export const QUICK_ADD_CASES: readonly QuickAddCase[] = [
  { input: 'meeting @may 17 3pm !high #test', now: 'wednesday' },
  { input: 'Buy groceries @today !high', now: 'wednesday' },
  { input: 'Review PR +work @next friday', now: 'wednesday' },
  { input: 'Water plants every 2 weeks', now: 'wednesday' },
  { input: 'Gym every monday', now: 'wednesday' },
  { input: 'Gym every monday', now: 'monday' },
  { input: 'pay rent every month', now: 'monthEnd' },
  { input: 'pay rent @feb 29 every month', now: 'leapDay' },
  { input: 'call bob @next wednesday call bob', now: 'wednesday' },
  { input: 'call @tomorrow at 3:30pm please', now: 'wednesday' },
  { input: 'plan @dec 20 at 3pm', now: 'yearEnd' },
  { input: 'Ship it!', now: 'wednesday' },
  { input: 'Wow!! amazing', now: 'wednesday' },
  { input: 'task !nope !low', now: 'wednesday' },
  { input: 'task !u', now: 'wednesday' },
  { input: 'task !MED', now: 'wednesday' },
  { input: 'task !none !high', now: 'wednesday' },
  { input: '1+2 is C++', now: 'wednesday' },
  { input: 'thing +unknown stays', now: 'wednesday' },
  { input: 'thing +project-alpha', now: 'wednesday' },
  { input: 'thing +proj', now: 'wednesday' },
  { input: 'thing +p-work', now: 'wednesday' },
  { input: 'thing +old', now: 'wednesday' },
  { input: 'thing +personal +work', now: 'wednesday' },
  { input: 'tagged #launch #work/client #a-b_c', now: 'wednesday' },
  { input: 'C# and issue#12 are prose', now: 'wednesday' },
  { input: '#first thing', now: 'wednesday' },
  { input: 'link [[Roadmap]] and [[Q3 #launch @tomorrow]]', now: 'wednesday' },
  { input: 'unclosed [[Roadmap', now: 'wednesday' },
  { input: 'empty [[ ]] link', now: 'wednesday' },
  { input: 'a@b.com is not a date', now: 'wednesday' },
  { input: '@ tomorrow is not either', now: 'wednesday' },
  { input: '@someday maybe', now: 'wednesday' },
  { input: 'multi @tomorrow and @friday', now: 'wednesday' },
  { input: 'standup every weekday @tomorrow 9am +work #daily !medium', now: 'wednesday' },
  { input: '   spaced    out   title   ', now: 'wednesday' },
  { input: 'emoji 🎉 @tomorrow #party', now: 'wednesday' },
  { input: 'Ünïcödé täsk #tag !high', now: 'wednesday' },
  { input: 'every door #x', now: 'wednesday' },
  { input: 'reunión @mañana', now: 'wednesday' },
  { input: 'x every day [[every day]]', now: 'wednesday' },
  { input: '', now: 'wednesday' },
  { input: '@dec 25 !urgent', now: 'yearEnd' }
]

export const COMPLETION_QUERIES: readonly string[] = [
  '',
  ' ',
  't',
  'to',
  'tom',
  'Tomo',
  'y',
  'mon',
  'w',
  'thu',
  'n',
  'ne',
  'next',
  'next ',
  'next m',
  'next fr',
  'last',
  'last s',
  'l',
  'j',
  'ju',
  'jul',
  'dec',
  'x',
  '12',
  '12:',
  '9',
  '24',
  'today 12',
  'today 12:',
  'today at 12',
  'today at 12:',
  'meeting 12',
  'next monday 9',
  'today at',
  'today at ',
  'today 12:3',
  'today 2p',
  'today at 14pm',
  'next monday 2:30p',
  '23:3',
  'next monday foo',
  'today 12:30'
]

export const REPEAT_COMPLETION_QUERIES: readonly string[] = [
  'e',
  'every',
  'every ',
  'every w',
  'every we',
  'every wee',
  'every week',
  'every weeke',
  'every 2',
  'every m',
  'every y',
  'EVERY D',
  'every x',
  'daily'
]
