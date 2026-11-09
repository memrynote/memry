import type { TasksCommandRepository, TasksDomainEvent } from './commands-types.ts'
import type { RepeatConfig, Task } from './types.ts'
import { completeRepeatingTask } from './parsing/recurrence.ts'
import { addDays, formatDateKey, parseDateKey } from './parsing/dates.ts'
import type { RepeatConfig as RecurrenceConfig } from './parsing/types.ts'

/** The task a repeating completion created. */
export interface NextOccurrence {
  id: string
  /** `YYYY-MM-DD`. */
  dueDate: string
}

export interface RepeatRoll {
  events: TasksDomainEvent[]
  /** The task the closed occurrence became (`repeatConfig` cleared), when it rolled. */
  closed: Task | null
  nextOccurrence: NextOccurrence | null
}

const NO_ROLL: RepeatRoll = { events: [], closed: null, nextOccurrence: null }

// Same reading of the stored JSON as the renderer's `dbRepeatConfigToUiRepeatConfig`.
function toRecurrenceConfig(config: RepeatConfig): RecurrenceConfig {
  return {
    ...config,
    interval: config.interval ?? 1,
    endDate: config.endDate ? new Date(config.endDate) : null,
    completedCount: config.completedCount ?? 0,
    createdAt: config.createdAt ? new Date(config.createdAt) : new Date()
  }
}

const MS_PER_DAY = 86_400_000

// The start keeps its distance to the due date: start Wednesday, due Sunday
// stays Wednesday to Sunday every week. A start that does not parse is kept.
function shiftStartDate(startDate: string | null, previousDue: Date, nextDue: Date): string | null {
  if (!startDate) return startDate
  const start = parseDateKey(startDate.slice(0, 10))
  if (Number.isNaN(start.getTime())) return startDate
  // Rounded because a DST change makes a local day 23 or 25 hours long.
  const shift = Math.round((nextDue.getTime() - previousDue.getTime()) / MS_PER_DAY)
  return formatDateKey(addDays(start, shift))
}

function defaultOpenStatusId(repository: TasksCommandRepository, task: Task): string | null {
  const open = repository
    .listStatuses(task.projectId)
    .filter((status) => !status.isDone)
    .toSorted((a, b) => a.position - b.position)
  return (open.find((status) => status.isDefault) ?? open[0])?.id ?? task.statusId
}

/**
 * Completing an open repeating task closes this occurrence and, while the
 * series continues, creates the next one (spec 004 D3; the Rust core's
 * `tasks::lifecycle::complete` writes the same). `before` is the task as it was
 * before the completion; one that was already complete, or has no due date or
 * repeat rule, does not roll. Runs inside the caller's unit of work.
 */
export function rollRepeatingSeries(
  repository: TasksCommandRepository,
  generateId: () => string,
  before: Task | undefined,
  completedAt: string
): RepeatRoll {
  if (!before?.repeatConfig || !before.dueDate || before.completedAt) return NO_ROLL
  const config = before.repeatConfig
  const previousDue = parseDateKey(before.dueDate.slice(0, 10))
  const { nextDueDate, completedCount } = completeRepeatingTask(
    {
      dueDate: previousDue,
      repeatConfig: toRecurrenceConfig(config),
      repeatFrom: before.repeatFrom
    },
    new Date(completedAt)
  )

  const closed = repository.updateTask(before.id, { repeatConfig: null }) ?? null
  const events: TasksDomainEvent[] = []
  if (closed) {
    events.push({
      kind: 'taskUpdated',
      payload: {
        id: before.id,
        task: closed,
        changes: { repeatConfig: null },
        changedFields: ['repeatConfig'],
        previous: { repeatConfig: config }
      }
    })
  }
  if (!nextDueDate) return { events, closed, nextOccurrence: null }

  const id = generateId()
  const dueDate = formatDateKey(nextDueDate)
  const now = new Date().toISOString()
  const created = repository.createTask({
    id,
    projectId: before.projectId,
    statusId: defaultOpenStatusId(repository, before),
    parentId: before.parentId,
    title: before.title,
    description: before.description,
    priority: before.priority,
    position: repository.getNextTaskPosition(before.projectId, before.parentId),
    dueDate,
    dueTime: before.dueTime,
    durationMinutes: before.durationMinutes,
    startDate: shiftStartDate(before.startDate, previousDue, nextDueDate),
    repeatConfig: { ...config, completedCount },
    repeatFrom: before.repeatFrom,
    sourceNoteId: null,
    completedAt: null,
    archivedAt: null,
    createdAt: now,
    modifiedAt: now,
    ...(before.fields ? { fields: before.fields } : {})
  })
  const tags = repository.getTaskTags(before.id)
  const linkedNoteIds = repository.getTaskNoteIds(before.id)
  const linkedCanvasIds = repository.getTaskCanvasIds(before.id)
  if (tags.length > 0) repository.setTaskTags(id, tags)
  if (linkedNoteIds.length > 0) repository.setTaskNotes(id, linkedNoteIds)
  if (linkedCanvasIds.length > 0) repository.setTaskCanvases(id, linkedCanvasIds)
  events.push({
    kind: 'taskCreated',
    payload: { task: { ...created, tags, linkedNoteIds, linkedCanvasIds } }
  })
  return { events, closed, nextOccurrence: { id, dueDate } }
}
