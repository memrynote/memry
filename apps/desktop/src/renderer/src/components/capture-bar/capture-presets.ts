/**
 * Task presets for the capture bar: the properties a user can set from the
 * presets chip before pressing Enter, and how they combine with the quick-add
 * syntax typed into the field.
 *
 * Both write the same state. The rule that keeps them from disagreeing:
 * - a token in the text overrides the matching preset (typing came last), and
 * - picking a value in the menu strips the conflicting token (the pick came last).
 * Lists (tags) union instead of overriding.
 */

import { startOfDay } from '@/lib/task-utils'
import { findQuickAddSpans } from '@/lib/quick-add-parser'
import type { ParsedQuickAdd, QuickAddSpanKind } from '@/lib/quick-add-parser'
import type { Priority, RepeatConfig } from '@/data/task-model'

export interface TaskPresets {
  /** `undefined` = the default, today (resolved when read, so it survives midnight). `null` = no date. */
  dueDate?: Date | null
  dueTime: string | null
  priority: Priority
  /** `null` = the surface's default project. */
  projectId: string | null
  /** `null` = the project's default to-do status. */
  statusId: string | null
  startDate: Date | null
  repeat: RepeatConfig | null
  reminderAt: Date | null
  tags: string[]
}

export type TaskPresetField = keyof TaskPresets

export interface MergedPresets {
  dueDate: Date | null
  dueTime: string | null
  priority: Priority
  projectId: string | null
  statusId: string | null
  startDate: Date | null
  repeat: RepeatConfig | null
  reminderAt: Date | null
  tags: string[]
}

export const DEFAULT_PRESETS: TaskPresets = {
  dueDate: undefined,
  dueTime: null,
  priority: 'none',
  projectId: null,
  statusId: null,
  startDate: null,
  repeat: null,
  reminderAt: null,
  tags: []
}

export const resolvePresetDueDate = (presets: TaskPresets, now: Date = new Date()): Date | null =>
  presets.dueDate === undefined ? startOfDay(now) : presets.dueDate

/** The token kinds a menu pick for `field` replaces. */
export const CONFLICTING_TOKENS: Partial<Record<TaskPresetField, QuickAddSpanKind[]>> = {
  dueDate: ['datePhrase'],
  priority: ['priority'],
  projectId: ['project'],
  repeat: ['repeat']
}

/** Case-insensitive union that keeps the first spelling seen. */
const unionTags = (first: string[], second: string[]): string[] => {
  const seen = new Set<string>()
  const result: string[] = []
  for (const tag of [...first, ...second]) {
    const key = tag.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    result.push(tag)
  }
  return result
}

/** What Enter will save: the parsed text laid over the presets. */
export function mergePresets(
  parsed: Pick<
    ParsedQuickAdd,
    'dueDate' | 'dueTime' | 'priority' | 'projectId' | 'repeat' | 'tags'
  >,
  presets: TaskPresets,
  now: Date = new Date()
): MergedPresets {
  const projectChangedByToken = parsed.projectId !== null && parsed.projectId !== presets.projectId

  return {
    dueDate: parsed.dueDate ?? resolvePresetDueDate(presets, now),
    dueTime: parsed.dueDate ? parsed.dueTime : presets.dueTime,
    priority: parsed.priority !== 'none' ? parsed.priority : presets.priority,
    projectId: parsed.projectId ?? presets.projectId,
    // A status belongs to one project; a token that moves the task elsewhere
    // makes the picked status meaningless.
    statusId: projectChangedByToken ? null : presets.statusId,
    startDate: presets.startDate,
    repeat: parsed.repeat ?? presets.repeat,
    reminderAt: presets.reminderAt,
    tags: unionTags(parsed.tags, presets.tags)
  }
}

/**
 * Remove every token of `kinds` from `value`, so a menu pick never leaves a
 * second, contradicting answer on screen.
 */
export function stripTokens(
  value: string,
  kinds: QuickAddSpanKind[],
  now: Date = new Date()
): string {
  const spans = findQuickAddSpans(value, now)
    .filter((span) => kinds.includes(span.kind))
    .sort((a, b) => b.start - a.start)
  if (spans.length === 0) return value

  let next = value
  for (const span of spans) {
    next = next.slice(0, span.start) + next.slice(span.end)
  }
  return next.replace(/[ \t]{2,}/g, ' ').trim()
}

/** True when `field` still holds its default. */
export const isPresetDefault = (presets: TaskPresets, field: TaskPresetField): boolean => {
  if (field === 'tags') return presets.tags.length === 0
  return presets[field] === DEFAULT_PRESETS[field]
}

export const hasNonDefaultPresets = (presets: TaskPresets): boolean =>
  (Object.keys(DEFAULT_PRESETS) as TaskPresetField[]).some(
    (field) => !isPresetDefault(presets, field)
  )
