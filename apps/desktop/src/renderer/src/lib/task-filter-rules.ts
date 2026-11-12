/**
 * Editing helpers for the advanced task filter (`TaskFilterGroup`). The tree
 * format and how it matches live in `@memry/domain-tasks/filtering`; this
 * module only builds and rewrites trees for the rule builder.
 */
import type {
  TaskFilterField,
  TaskFilterGroup,
  TaskFilterMatch,
  TaskFilterNode,
  TaskFilterRule
} from '@memry/domain-tasks/filtering'
import { formatDateKey } from '@memry/domain-tasks/parsing'
import { defaultDueDateFilter, type TaskFilters } from '@/data/tasks-data'

export const RULE_FIELDS: readonly TaskFilterField[] = [
  'title',
  'status',
  'priority',
  'due',
  'project',
  'location',
  'tags',
  'repeat',
  'hasTime'
]

export const GROUP_MATCHES: readonly TaskFilterMatch[] = ['all', 'any', 'none']

/** Operators per field, positive ones first; the builder lists them in this order. */
export const RULE_OPS = {
  title: ['contains', 'notContains'],
  priority: ['any', 'none'],
  status: ['any', 'none'],
  project: ['any', 'none'],
  tags: ['any', 'all', 'none', 'empty', 'notEmpty'],
  due: ['is', 'isNot'],
  location: ['any', 'none'],
  repeat: ['is'],
  hasTime: ['is']
} as const satisfies {
  [F in TaskFilterField]: ReadonlyArray<Extract<TaskFilterRule, { field: F }>['op']>
}

export type RuleOp = (typeof RULE_OPS)[TaskFilterField][number]

const NEGATIVE_OPS = new Set<string>(['notContains', 'none', 'isNot'])

/** Ops that exclude tasks; the builder tints them so an exclusion reads at a glance. */
export const isNegativeOp = (op: string): boolean => NEGATIVE_OPS.has(op)

/** Ops that take no value. */
export const isValuelessOp = (op: string): boolean => op === 'empty' || op === 'notEmpty'

export const newRule = (field: TaskFilterField): TaskFilterRule => {
  switch (field) {
    case 'location':
      return { field, op: 'any', folderPaths: [], noteIds: [] }
    case 'due':
      return { field, op: 'is', values: [] }
    case 'repeat':
      return { field, op: 'is', values: ['repeating'] }
    case 'hasTime':
      return { field, op: 'is', values: ['with-time'] }
    case 'title':
      return { field, op: 'contains', values: [] }
    default:
      return { field, op: 'any', values: [] }
  }
}

export const emptyExpression = (): TaskFilterGroup => ({ match: 'all', rules: [] })

/**
 * Moves the chip dimensions into rules, so opening the builder keeps the list
 * as it was. Search and the completion scope stay chips: the search box and
 * the tabs own them. Returns the rules and the chip values to clear.
 */
export const seedExpressionFromFilters = (
  filters: TaskFilters
): { expression: TaskFilterGroup; cleared: Partial<TaskFilters> } => {
  const rules: TaskFilterRule[] = []
  if (filters.statusIds.length > 0)
    rules.push({ field: 'status', op: 'any', values: filters.statusIds })
  if (filters.priorities.length > 0) {
    rules.push({ field: 'priority', op: 'any', values: filters.priorities })
  }
  const due = filters.dueDate
  if (due.type === 'custom' && due.customStart && due.customEnd) {
    rules.push({
      field: 'due',
      op: 'is',
      values: ['custom'],
      dueStart: formatDateKey(due.customStart),
      dueEnd: formatDateKey(due.customEnd)
    })
  } else if (due.type !== 'any' && due.type !== 'custom') {
    rules.push({ field: 'due', op: 'is', values: [due.type] })
  }
  if (filters.projectIds.length > 0) {
    rules.push({ field: 'project', op: 'any', values: filters.projectIds })
  }
  const folderPaths = filters.folderPaths ?? []
  const noteIds = filters.noteIds ?? []
  if (folderPaths.length > 0 || noteIds.length > 0) {
    rules.push({ field: 'location', op: 'any', folderPaths, noteIds })
  }
  if (filters.tags.length > 0) rules.push({ field: 'tags', op: 'any', values: filters.tags })
  if (filters.repeatType !== 'all') {
    rules.push({ field: 'repeat', op: 'is', values: [filters.repeatType] })
  }
  if (filters.hasTime !== 'all')
    rules.push({ field: 'hasTime', op: 'is', values: [filters.hasTime] })

  const existing = filters.expression
  const expression: TaskFilterGroup =
    existing?.match === 'all'
      ? { match: 'all', rules: [...rules, ...existing.rules] }
      : { match: 'all', rules: existing ? [...rules, existing] : rules }

  return {
    expression,
    cleared: {
      statusIds: [],
      priorities: [],
      dueDate: defaultDueDateFilter,
      projectIds: [],
      folderPaths: [],
      noteIds: [],
      tags: [],
      repeatType: 'all',
      hasTime: 'all'
    }
  }
}

/** Index path from the root group to a node: `[2, 0]` is the first rule of the third node. */
export type NodePath = readonly number[]

const isGroup = (node: TaskFilterNode): node is TaskFilterGroup => 'match' in node

/** The tree with the node at `path` replaced by `update(node)`, or removed when it returns null. */
export const updateNodeAt = (
  root: TaskFilterGroup,
  path: NodePath,
  update: (node: TaskFilterNode) => TaskFilterNode | null
): TaskFilterGroup => {
  const [index, ...rest] = path
  if (index === undefined) {
    const next = update(root)
    return next && isGroup(next) ? next : emptyExpression()
  }
  const rules: TaskFilterNode[] = []
  root.rules.forEach((node, i) => {
    if (i !== index) {
      rules.push(node)
      return
    }
    const next =
      rest.length === 0 ? update(node) : isGroup(node) ? updateNodeAt(node, rest, update) : node
    if (next) rules.push(next)
  })
  return { ...root, rules }
}

export const appendNodeAt = (
  root: TaskFilterGroup,
  groupPath: NodePath,
  node: TaskFilterNode
): TaskFilterGroup =>
  updateNodeAt(root, groupPath, (group) =>
    isGroup(group) ? { ...group, rules: [...group.rules, node] } : group
  )

/** The stored tree, or null once nothing is left in it. */
export const normalizeExpression = (root: TaskFilterGroup): TaskFilterGroup | null =>
  root.rules.length === 0 ? null : root
