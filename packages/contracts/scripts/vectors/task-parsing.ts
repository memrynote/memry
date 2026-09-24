/**
 * Class: task parsing (`task-parsing.json`) — spec 004 D1, D3, D4, D5.
 *
 * Natural-language dates, quick-add, repeat phrases, ghost completion,
 * recurrence and due-window membership, recorded from the real
 * `@memry/domain-tasks/parsing` functions the desktop renderer runs. The
 * generator enumerates inputs and records outputs; it never predicts them.
 *
 * Determinism: the process time zone is pinned to UTC for the build, and every
 * function receives an explicit `now`. Dates are local calendar keys
 * (`YYYY-MM-DD`), instants are local wall-clock (`YYYY-MM-DDTHH:MM:SS`), and
 * span offsets are JavaScript string indices (UTF-16 code units).
 */
import {
  calculateNextOccurrence,
  calculateNextOccurrences,
  completeRepeatingTask,
  findNthWeekdayOfMonth,
  findQuickAddSpans,
  findRepeatPhrase,
  firstOccurrenceFor,
  formatDateKey,
  getCompletedTasks,
  getCompletedTasksInDueWindow,
  getCompletedTodayTasks,
  getFilteredTasks,
  getRepeatProgress,
  getTaskTabCounts,
  getTasksInDueWindow,
  hasSpecialSyntax,
  isTimeInProgress,
  parseDateKey,
  parseNaturalDate,
  parseQuickAdd,
  parseRepeatPhrase,
  predictDateCompletion,
  predictRepeatCompletion,
  predictTime,
  shouldCreateNextOccurrence,
  type RepeatConfig,
  type TaskDueWindow,
  type ViewTask
} from '../../../domain-tasks/src/parsing/index.ts'
import {
  COMPLETION_QUERIES,
  NATURAL_DATE_INPUTS,
  NOWS,
  QUICK_ADD_CASES,
  QUICK_ADD_PROJECTS,
  REPEAT_COMPLETION_QUERIES,
  REPEAT_FIND_INPUTS,
  REPEAT_PHRASES,
  type NowKey
} from './task-parsing-cases'
import {
  COMPLETE_CASES,
  NEXT_FROM_DATES,
  REPEAT_CONFIGS,
  VIEW_IDS,
  WINDOW_PROJECTS,
  WINDOW_TASKS,
  type WireRepeat
} from './task-recurrence-cases'

const now = (key: NowKey): Date => new Date(NOWS[key])
const day = (date: Date | null): string | null => (date ? formatDateKey(date) : null)

/** The wire shape desktop writes (`use-task-queries.ts` `toServiceRepeatConfig`). */
function toWire(config: RepeatConfig | null): WireRepeat | null {
  if (!config) return null
  return JSON.parse(
    JSON.stringify({
      frequency: config.frequency,
      interval: config.interval,
      daysOfWeek: config.daysOfWeek,
      monthlyType: config.monthlyType,
      dayOfMonth: config.dayOfMonth,
      weekOfMonth: config.weekOfMonth,
      dayOfWeekForMonth: config.dayOfWeekForMonth,
      endType: config.endType,
      endDate: config.endDate ? formatDateKey(config.endDate) : null,
      endCount: config.endCount,
      completedCount: config.completedCount,
      createdAt: config.createdAt.toISOString()
    })
  ) as WireRepeat
}

/** The read the renderer does (`use-task-queries.ts` `dbRepeatConfigToUiRepeatConfig`). */
function fromWire(wire: WireRepeat): RepeatConfig {
  return {
    ...wire,
    endDate: wire.endDate ? new Date(wire.endDate) : null,
    createdAt: new Date(wire.createdAt)
  }
}

/** Stored task dates, parsed as the renderer does (`parseDueDate`). */
const storedDate = (value: string | null): Date | null =>
  value === null ? null : /^\d{4}-\d{2}-\d{2}$/.test(value) ? parseDateKey(value) : new Date(value)

function buildNaturalDate() {
  const cases = []
  for (const nowKey of Object.keys(NOWS) as NowKey[]) {
    for (const input of NATURAL_DATE_INPUTS) {
      const result = parseNaturalDate(input, now(nowKey))
      cases.push({
        now: NOWS[nowKey],
        input,
        expected: result.success
          ? {
              success: true,
              date: day(result.result.date),
              time: result.result.time,
              displayText: result.displayText
            }
          : { success: false, error: result.error }
      })
    }
  }
  return cases
}

function buildRepeatPhrase() {
  const anchor = new Date('2026-03-18T00:00:00')
  const parse = REPEAT_PHRASES.map((phrase) => ({
    phrase,
    anchor: day(anchor),
    now: NOWS.wednesday,
    expected: toWire(parseRepeatPhrase(phrase, anchor, now('wednesday')))
  }))
  const find = REPEAT_FIND_INPUTS.map((input) => {
    const match = findRepeatPhrase(input, anchor, now('wednesday'))
    return {
      input,
      anchor: day(anchor),
      now: NOWS.wednesday,
      expected: match
        ? { start: match.start, end: match.end, text: match.text, config: toWire(match.config) }
        : null
    }
  })
  const firstOccurrence = []
  for (const name of ['daily', 'weekdays', 'monWedFri', 'sundays', 'weekly', 'monthly15']) {
    for (const nowKey of ['wednesday', 'sunday', 'saturday'] as NowKey[]) {
      firstOccurrence.push({
        config: name,
        from: NOWS[nowKey],
        expected: day(firstOccurrenceFor(fromWire(REPEAT_CONFIGS[name]), now(nowKey)))
      })
    }
  }
  return { parse, find, firstOccurrence }
}

function buildQuickAdd() {
  return QUICK_ADD_CASES.map(({ input, now: nowKey }) => {
    const parsed = parseQuickAdd(input, QUICK_ADD_PROJECTS, now(nowKey))
    return {
      input,
      now: NOWS[nowKey],
      expected: {
        title: parsed.title,
        dueDate: day(parsed.dueDate),
        dueTime: parsed.dueTime,
        priority: parsed.priority,
        projectId: parsed.projectId,
        repeat: toWire(parsed.repeat),
        tags: parsed.tags,
        noteTitles: parsed.noteTitles,
        spans: findQuickAddSpans(input, now(nowKey)),
        hasSpecialSyntax: hasSpecialSyntax(input, now(nowKey))
      }
    }
  })
}

function buildCompletion() {
  const date = []
  for (const nowKey of ['wednesday', 'sunday'] as NowKey[]) {
    for (const query of COMPLETION_QUERIES) {
      date.push({
        query,
        now: NOWS[nowKey],
        predictDateCompletion: predictDateCompletion(query, now(nowKey)),
        predictTime: predictTime(query, now(nowKey)),
        isTimeInProgress: isTimeInProgress(query, now(nowKey))
      })
    }
  }
  const repeat = REPEAT_COMPLETION_QUERIES.map((query) => ({
    query,
    expected: predictRepeatCompletion(query)
  }))
  return { date, repeat }
}

function buildRecurrence() {
  const next = []
  const occurrences = []
  for (const [name, wire] of Object.entries(REPEAT_CONFIGS)) {
    const config = fromWire(wire)
    for (const from of NEXT_FROM_DATES) {
      next.push({
        config: name,
        from,
        expected: day(calculateNextOccurrence(parseDateKey(from), config))
      })
    }
    occurrences.push({
      config: name,
      start: '2026-01-14',
      count: 6,
      expected: calculateNextOccurrences(parseDateKey('2026-01-14'), config, 6).map(day)
    })
  }
  const shouldCreate = []
  for (const name of [
    'daily',
    'dailyUntil',
    'dailyCount3',
    'dailyCount3Done3',
    'countZero',
    'dateNull'
  ]) {
    for (const at of ['2026-01-14T12:00:00', '2026-01-20T23:59:59', '2026-01-21T00:00:00']) {
      shouldCreate.push({
        config: name,
        now: at,
        expected: shouldCreateNextOccurrence(fromWire(REPEAT_CONFIGS[name]), new Date(at))
      })
    }
  }
  const complete = COMPLETE_CASES.map((c) => {
    const result = completeRepeatingTask(
      {
        dueDate: parseDateKey(c.due),
        repeatConfig: fromWire(REPEAT_CONFIGS[c.config]),
        repeatFrom: c.repeatFrom
      },
      new Date(c.completedAt)
    )
    return {
      ...c,
      expected: { nextDueDate: day(result.nextDueDate), completedCount: result.completedCount }
    }
  })
  const nthWeekday = []
  for (const [year, month] of [
    [2026, 0],
    [2026, 1],
    [2024, 1],
    [2026, 11]
  ]) {
    for (const nth of [1, 2, 3, 4, 5]) {
      for (const dow of [0, 1, 5, 6]) {
        nthWeekday.push({
          year,
          month,
          nth,
          dayOfWeek: dow,
          expected: day(findNthWeekdayOfMonth(year, month, nth, dow))
        })
      }
    }
  }
  const progress = Object.entries(REPEAT_CONFIGS).map(([name, wire]) => ({
    config: name,
    expected: getRepeatProgress(fromWire(wire))
  }))
  return {
    configs: REPEAT_CONFIGS,
    next,
    occurrences,
    shouldCreate,
    complete,
    nthWeekday,
    progress
  }
}

function buildDueWindows() {
  const tasks: ViewTask[] = WINDOW_TASKS.map((task) => ({
    ...task,
    dueDate: storedDate(task.dueDate),
    startDate: storedDate(task.startDate),
    completedAt: task.completedAt === null ? null : new Date(task.completedAt),
    archivedAt: task.archivedAt === null ? null : new Date(task.archivedAt)
  }))
  const ids = (list: readonly ViewTask[]): string[] => list.map((task) => task.id)
  const windows: TaskDueWindow[] = ['today', 'tomorrow', 'next7']
  const at = (['wednesday', 'sunday'] as NowKey[]).map((nowKey) => {
    const clock = now(nowKey)
    return {
      now: NOWS[nowKey],
      windows: Object.fromEntries(
        windows.map((w) => [w, ids(getTasksInDueWindow(tasks, WINDOW_PROJECTS, w, clock))])
      ),
      completedInWindow: Object.fromEntries(
        windows.map((w) => [w, ids(getCompletedTasksInDueWindow(tasks, w, clock))])
      ),
      completedToday: ids(getCompletedTodayTasks(tasks, clock)),
      completedAll: ids(getCompletedTasks(tasks)),
      views: Object.fromEntries(
        VIEW_IDS.map((v) => [v, ids(getFilteredTasks(tasks, v, 'view', WINDOW_PROJECTS, clock))])
      ),
      projects: Object.fromEntries(
        ['p1', 'p2', 'nope'].map((p) => [
          p,
          ids(getFilteredTasks(tasks, p, 'project', WINDOW_PROJECTS, clock))
        ])
      ),
      tabCounts: Object.fromEntries(
        [null, 'p1', 'p2'].map((scope) => [
          scope ?? '*',
          getTaskTabCounts(tasks, WINDOW_PROJECTS, scope, clock)
        ])
      )
    }
  })
  return { projects: WINDOW_PROJECTS, tasks: WINDOW_TASKS, at }
}

export function buildTaskParsing(): unknown {
  const previous = process.env.TZ
  process.env.TZ = 'UTC'
  try {
    return {
      meta: {
        spec: '004-ios-tasks-parity',
        source: 'packages/domain-tasks/src/parsing',
        timeZone: 'UTC',
        dates: 'YYYY-MM-DD local calendar keys; instants are local YYYY-MM-DDTHH:MM:SS',
        offsets: 'UTF-16 code units (JavaScript string indices), end exclusive',
        repeatConfig: 'wire shape: endDate YYYY-MM-DD | null, createdAt ISO-8601 UTC'
      },
      quickAddProjects: QUICK_ADD_PROJECTS,
      naturalDate: buildNaturalDate(),
      repeatPhrase: buildRepeatPhrase(),
      quickAdd: buildQuickAdd(),
      completion: buildCompletion(),
      recurrence: buildRecurrence(),
      dueWindows: buildDueWindows()
    }
  } finally {
    if (previous === undefined) delete process.env.TZ
    else process.env.TZ = previous
  }
}
