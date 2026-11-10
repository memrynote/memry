/**
 * Advanced task filter: rules combined with all / any / none groups.
 *
 * The tree is JSON as stored and synced (a saved filter's top-level
 * `expression`, docs/protocol §13.7.14), so it holds only strings: a custom due
 * range is a pair of `YYYY-MM-DD` local date keys. Each rule reuses the
 * dimension filter the chip filters run, so a rule and the chip it replaces
 * match the same tasks.
 *
 * A rule this build cannot evaluate, because a newer build wrote a field or
 * operator it does not know or because the rule has no value yet, is skipped:
 * it drops out of its group instead of matching everything or nothing. A group
 * with nothing left to evaluate is skipped the same way.
 */
import { parseDateKey } from '../parsing/dates.ts'
import type { Priority } from '../parsing/types.ts'
import {
  filterByDueDateRange,
  filterByHasTime,
  filterByLocation,
  filterByProjects,
  filterByRepeatType,
  filterByStatuses,
  filterByTags
} from './dimensions.ts'
import type {
  DueDateFilterType,
  FilterTask,
  HasTimeFilterType,
  RepeatFilterType,
  TaskNoteIndex
} from './types.ts'

export type TaskFilterMatch = 'all' | 'any' | 'none'

export type TaskFilterRule =
  | { field: 'title'; op: 'contains' | 'notContains'; values: string[] }
  | { field: 'priority'; op: 'any' | 'none'; values: Priority[] }
  | { field: 'status'; op: 'any' | 'none'; values: string[] }
  | { field: 'project'; op: 'any' | 'none'; values: string[] }
  | { field: 'tags'; op: 'any' | 'all' | 'none' | 'empty' | 'notEmpty'; values: string[] }
  | {
      field: 'due'
      op: 'is' | 'isNot'
      values: Array<Exclude<DueDateFilterType, 'any'>>
      /** `YYYY-MM-DD`; read only when `values` holds `custom`. */
      dueStart?: string | null
      dueEnd?: string | null
    }
  | {
      field: 'location'
      op: 'any' | 'none'
      /** Vault-relative folders, subfolders included. */
      folderPaths: string[]
      noteIds: string[]
    }
  | { field: 'repeat'; op: 'is'; values: Array<Exclude<RepeatFilterType, 'all'>> }
  | { field: 'hasTime'; op: 'is'; values: Array<Exclude<HasTimeFilterType, 'all'>> }

export type TaskFilterField = TaskFilterRule['field']

export interface TaskFilterGroup {
  match: TaskFilterMatch
  rules: TaskFilterNode[]
}

export type TaskFilterNode = TaskFilterGroup | TaskFilterRule

export const isTaskFilterGroup = (node: TaskFilterNode): node is TaskFilterGroup => 'match' in node

export interface TaskFilterContext {
  now: Date
  weekStartsOn: 0 | 1
  /** Required for a `location` rule to match anything; see `filterByLocation`. */
  noteIndex?: TaskNoteIndex
}

/** Whether a dimension filter run over a single task kept it. */
const kept = (filtered: readonly FilterTask[]): boolean => filtered.length === 1

const DATE_KEY = /^\d{4}-\d{2}-\d{2}$/

const strings = (list: unknown): string[] =>
  Array.isArray(list) ? list.filter((v): v is string => typeof v === 'string') : []

type DuePreset = Exclude<DueDateFilterType, 'any' | 'custom'>

const DUE_PRESETS: ReadonlySet<string> = new Set<DuePreset>([
  'none',
  'overdue',
  'today',
  'tomorrow',
  'this-week',
  'next-week',
  'this-month'
])

const isDuePreset = (value: string): value is DuePreset => DUE_PRESETS.has(value)

const matchesDue = (
  task: FilterTask,
  rule: Extract<TaskFilterRule, { field: 'due' }>,
  ctx: TaskFilterContext
): boolean | null => {
  const checks: Array<() => boolean> = []
  for (const value of strings(rule.values)) {
    if (isDuePreset(value)) {
      checks.push(() =>
        kept(filterByDueDateRange([task], { type: value }, ctx.now, ctx.weekStartsOn))
      )
    } else if (
      value === 'custom' &&
      typeof rule.dueStart === 'string' &&
      typeof rule.dueEnd === 'string' &&
      DATE_KEY.test(rule.dueStart) &&
      DATE_KEY.test(rule.dueEnd)
    ) {
      const customStart = parseDateKey(rule.dueStart)
      const customEnd = parseDateKey(rule.dueEnd)
      checks.push(() =>
        kept(
          filterByDueDateRange(
            [task],
            { type: 'custom', customStart, customEnd },
            ctx.now,
            ctx.weekStartsOn
          )
        )
      )
    }
  }
  if (checks.length === 0) return null
  return checks.some((check) => check())
}

/** Applies `op` to a positive match, or skips a rule whose operator is unknown. */
const withOp = (op: string, positive: string, negative: string, hit: boolean): boolean | null => {
  if (op === positive) return hit
  if (op === negative) return !hit
  return null
}

/**
 * `true` or `false` for a rule this build can evaluate, `null` for one it
 * skips (unknown field or operator, or no value yet).
 *
 * The tree comes from storage and sync, so every read below tolerates a shape
 * other than the type says: a newer build's field reaches `default`, and a
 * value list that is not strings counts as empty.
 */
export const evaluateTaskFilterRule = (
  task: FilterTask,
  rule: TaskFilterRule,
  ctx: TaskFilterContext
): boolean | null => {
  const op: string = rule.op
  switch (rule.field) {
    case 'title': {
      const query = strings(rule.values)[0]?.trim().toLowerCase() ?? ''
      if (query === '') return null
      return withOp(op, 'contains', 'notContains', task.title.toLowerCase().includes(query))
    }
    case 'priority': {
      // An unknown priority matches no task, as in the chip filter.
      const list = strings(rule.values)
      if (list.length === 0) return null
      return withOp(op, 'any', 'none', list.includes(task.priority))
    }
    case 'status': {
      const list = strings(rule.values)
      if (list.length === 0) return null
      return withOp(op, 'any', 'none', kept(filterByStatuses([task], list)))
    }
    case 'project': {
      const list = strings(rule.values)
      if (list.length === 0) return null
      return withOp(op, 'any', 'none', kept(filterByProjects([task], list)))
    }
    case 'tags': {
      if (op === 'empty') return task.tags.length === 0
      if (op === 'notEmpty') return task.tags.length > 0
      const list = strings(rule.values)
      if (list.length === 0) return null
      if (op === 'all') return list.every((tag) => kept(filterByTags([task], [tag])))
      return withOp(op, 'any', 'none', kept(filterByTags([task], list)))
    }
    case 'due': {
      const hit = matchesDue(task, rule, ctx)
      if (hit === null) return null
      return withOp(op, 'is', 'isNot', hit)
    }
    case 'location': {
      const folderPaths = strings(rule.folderPaths)
      const noteIds = strings(rule.noteIds)
      if (folderPaths.length === 0 && noteIds.length === 0) return null
      const hit = kept(filterByLocation([task], folderPaths, noteIds, ctx.noteIndex))
      return withOp(op, 'any', 'none', hit)
    }
    case 'repeat': {
      const value = strings(rule.values)[0]
      if ((value !== 'repeating' && value !== 'one-time') || op !== 'is') return null
      return kept(filterByRepeatType([task], value))
    }
    case 'hasTime': {
      const value = strings(rule.values)[0]
      if ((value !== 'with-time' && value !== 'without-time') || op !== 'is') return null
      return kept(filterByHasTime([task], value))
    }
    default:
      return null
  }
}

const GROUP_MATCHES = new Set<string>(['all', 'any', 'none'])

/** Same contract as `evaluateTaskFilterRule`, for a whole group. */
export const evaluateTaskFilterGroup = (
  task: FilterTask,
  group: TaskFilterGroup,
  ctx: TaskFilterContext
): boolean | null => {
  const match: string = group.match
  if (!GROUP_MATCHES.has(match)) return null
  const results: boolean[] = []
  for (const node of Array.isArray(group.rules) ? group.rules : []) {
    const result = isTaskFilterGroup(node)
      ? evaluateTaskFilterGroup(task, node, ctx)
      : evaluateTaskFilterRule(task, node, ctx)
    if (result !== null) results.push(result)
  }
  if (results.length === 0) return null
  if (match === 'all') return results.every(Boolean)
  if (match === 'any') return results.some(Boolean)
  return !results.some(Boolean)
}

/** Whether a task passes the expression. A fully skipped expression passes every task. */
export const matchesTaskFilterExpression = (
  task: FilterTask,
  expression: TaskFilterGroup,
  ctx: TaskFilterContext
): boolean => evaluateTaskFilterGroup(task, expression, ctx) ?? true

/**
 * Rules this build evaluates, at any depth, inside groups it evaluates. A probe
 * task stands in for "has a value and a known field and operator": the result
 * is `null` exactly when the rule is skipped, whatever the task.
 */
export const countTaskFilterRules = (expression: TaskFilterGroup | null | undefined): number => {
  if (!expression) return 0
  let count = 0
  const visit = (group: TaskFilterGroup): void => {
    if (!GROUP_MATCHES.has(group.match)) return
    for (const node of Array.isArray(group.rules) ? group.rules : []) {
      if (isTaskFilterGroup(node)) visit(node)
      else if (evaluateTaskFilterRule(PROBE_TASK, node, PROBE_CONTEXT) !== null) count++
    }
  }
  visit(expression)
  return count
}

const PROBE_TASK: FilterTask = {
  id: '',
  title: '',
  projectId: '',
  statusId: '',
  parentId: null,
  priority: 'none',
  dueDate: null,
  dueTime: null,
  createdAt: new Date(0),
  completedAt: null,
  archivedAt: null,
  isRepeating: false,
  tags: [],
  sourceNoteId: null,
  linkedNoteIds: []
}

const PROBE_CONTEXT: TaskFilterContext = { now: new Date(0), weekStartsOn: 0 }
