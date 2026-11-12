import type { TaskFilterGroup, TaskFilterNode, TaskFilterRule } from '@memry/domain-tasks/filtering'
import { priorityConfig, type Priority } from '@/data/task-model'
import { dueDateFilterLabel, type DueDateFilterType, type Project } from '@/data/tasks-data'
import type { TaskNoteIndex } from '@/lib/task-note-index'
import { RULE_OPS, isValuelessOp } from '@/lib/task-filter-rules'

type Translate = (key: string, values?: Record<string, unknown>) => string

export interface RuleLabelContext {
  projects: readonly Project[]
  noteIndex?: TaskNoteIndex
  t: Translate
}

const K = 'filters.advanced'

export const fieldLabel = (field: string, t: Translate): string =>
  field in RULE_OPS ? t(`${K}.fields.${field}`) : t(`${K}.unknownRule`)

export const opLabel = (field: string, op: string, t: Translate): string =>
  field === 'tags' && (op === 'any' || op === 'all' || op === 'none')
    ? t(`${K}.tagOps.${op}`)
    : t(`${K}.ops.${op}`)

export const matchLabel = (match: string, t: Translate): string => t(`${K}.matches.${match}`)

const VALUE_KEYS: Record<string, string> = {
  repeating: 'repeating',
  'one-time': 'oneTime',
  'with-time': 'withTime',
  'without-time': 'withoutTime'
}

const statusName = (projects: readonly Project[], id: string): string => {
  for (const project of projects) {
    const status = project.statuses.find((s) => s.id === id)
    if (status) return status.name
  }
  return id
}

/** Display labels for a rule's values, in the order the rule holds them. */
export const ruleValueLabels = (rule: TaskFilterRule, ctx: RuleLabelContext): string[] => {
  const { t } = ctx
  switch (rule.field) {
    case 'title':
      return rule.values.filter((v) => v.trim() !== '')
    case 'priority':
      return rule.values.map((p: Priority) => priorityConfig[p]?.label ?? p)
    case 'status':
      return rule.values.map((id) => statusName(ctx.projects, id))
    case 'project':
      return rule.values.map((id) => ctx.projects.find((p) => p.id === id)?.name ?? id)
    case 'tags':
      return isValuelessOp(rule.op) ? [] : rule.values.map((tag) => `#${tag}`)
    case 'due':
      return rule.values.map((value) =>
        value === 'custom'
          ? `${rule.dueStart ?? '…'} – ${rule.dueEnd ?? '…'}`
          : dueDateFilterLabel(value as DueDateFilterType)
      )
    case 'location':
      return [
        ...rule.folderPaths.map((path) => path.split('/').pop() || path),
        ...rule.noteIds.map((id) => ctx.noteIndex?.get(id)?.title ?? id)
      ]
    case 'repeat':
    case 'hasTime':
      return rule.values.map((value) =>
        VALUE_KEYS[value] ? t(`${K}.values.${VALUE_KEYS[value]}`) : value
      )
    // A newer build's field: the row shows it as unknown, with no values.
    default:
      return []
  }
}

export interface SummaryToken {
  text: string
  kind: 'field' | 'value' | 'logic' | 'paren'
}

const isGroup = (node: TaskFilterNode): node is TaskFilterGroup => 'match' in node

/**
 * The rules read back as one sentence: "Tags #work and ( Urgent or Overdue )
 * and not #someday". Rules without a value are left out, as the evaluator
 * skips them.
 */
export const summarizeExpression = (
  root: TaskFilterGroup,
  ctx: RuleLabelContext
): SummaryToken[] => {
  const { t } = ctx
  const and = t(`${K}.summary.and`)
  const or = t(`${K}.summary.or`)
  const not = t(`${K}.summary.not`)

  const ruleTokens = (rule: TaskFilterRule): SummaryToken[] | null => {
    if (!(rule.field in RULE_OPS)) return null
    const values = ruleValueLabels(rule, ctx)
    if (rule.field === 'tags' && isValuelessOp(rule.op)) {
      return [
        { text: fieldLabel(rule.field, t), kind: 'field' },
        { text: opLabel(rule.field, rule.op, t), kind: 'value' }
      ]
    }
    if (values.length === 0) return null
    const negative = rule.op === 'none' || rule.op === 'isNot' || rule.op === 'notContains'
    const joiner = rule.field === 'tags' && rule.op === 'all' ? and : or
    const tokens: SummaryToken[] = []
    if (negative) tokens.push({ text: not, kind: 'logic' })
    tokens.push({ text: fieldLabel(rule.field, t), kind: 'field' })
    values.forEach((value, i) => {
      if (i > 0) tokens.push({ text: joiner, kind: 'logic' })
      tokens.push({ text: value, kind: 'value' })
    })
    return tokens
  }

  const groupTokens = (group: TaskFilterGroup, nested: boolean): SummaryToken[] | null => {
    const parts = group.rules
      .map((node) => (isGroup(node) ? groupTokens(node, true) : ruleTokens(node)))
      .filter((part): part is SummaryToken[] => part !== null && part.length > 0)
    if (parts.length === 0) return null
    const joiner = group.match === 'any' ? or : and
    const tokens: SummaryToken[] = []
    if (group.match === 'none') tokens.push({ text: not, kind: 'logic' })
    const wrap = group.match === 'none' || (nested && parts.length > 1)
    if (wrap) tokens.push({ text: '(', kind: 'paren' })
    parts.forEach((part, i) => {
      if (i > 0) tokens.push({ text: group.match === 'none' ? or : joiner, kind: 'logic' })
      tokens.push(...part)
    })
    if (wrap) tokens.push({ text: ')', kind: 'paren' })
    return tokens
  }

  return groupTokens(root, false) ?? []
}
