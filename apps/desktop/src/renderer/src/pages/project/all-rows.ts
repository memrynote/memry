import type { Task } from '@/data/task-model'
import type { Project } from '@/data/tasks-data'
import type { ProjectLinkedEvent, ProjectLinkedNote } from '@memry/rpc/tasks'

export type AllRowType = 'note' | 'task' | 'event'

/** The status words a note or event row shows. A task row shows its own status control. */
export type AllRowStatus = 'active' | 'done' | 'upcoming' | 'past'

export interface AllRow {
  key: string
  type: AllRowType
  /** Id of the note, task or event. Notes and tasks share a namespace in `key`, not here. */
  id: string
  title: string
  emoji: string | null
  /** Set on a task nested under a note. */
  parentNoteId: string | null
  start: Date | null
  due: Date | null
  /** Notes and events only. */
  status: AllRowStatus | null
  isDone: boolean
  task: Task | null
  note: ProjectLinkedNote | null
  /** Only on a note that carries tasks. */
  taskSummary: { open: number; total: number } | null
  event: ProjectLinkedEvent | null
}

export type AllSortKey = 'title' | 'due'
export interface AllSort {
  key: AllSortKey
  dir: 'asc' | 'desc'
}

export interface AllRowsInput {
  project: Project
  /** The project's own tasks. */
  projectTasks: readonly Task[]
  /** Every task, so tasks written in or linked to a project note come along. */
  allTasks: readonly Task[]
  notes: readonly ProjectLinkedNote[]
  events: readonly ProjectLinkedEvent[]
  now: Date
  showDone: boolean
}

const startOfDay = (date: Date): Date =>
  new Date(date.getFullYear(), date.getMonth(), date.getDate())

/** Whole local days from `now` to `due`. Negative once the day has passed. */
export const daysLeft = (due: Date, now: Date): number =>
  Math.round((startOfDay(due).getTime() - startOfDay(now).getTime()) / 86_400_000)

const earliest = (dates: (Date | null | undefined)[]): Date | null =>
  dates.reduce<Date | null>((best, d) => (d && (!best || d < best) ? d : best), null)

const latest = (dates: (Date | null | undefined)[]): Date | null =>
  dates.reduce<Date | null>((best, d) => (d && (!best || d > best) ? d : best), null)

const byDue = (a: AllRow, b: AllRow): number => {
  if (a.due && b.due) return a.due.getTime() - b.due.getTime()
  if (a.due) return -1
  if (b.due) return 1
  return a.title.localeCompare(b.title)
}

const isTaskDone = (task: Task, project: Project): boolean =>
  Boolean(task.completedAt) ||
  project.statuses.find((status) => status.id === task.statusId)?.type === 'done'

/**
 * The rows of a project's All tab: its notes with the tasks written in or linked
 * to them nested underneath, the tasks that belong to no note, and its events.
 *
 * A task linked to several notes nests under the first (its source note, then its
 * links) so the table never lists it twice. Open items only unless `showDone`.
 * A note has no dates of its own, so its start and due come from its open tasks.
 */
export function buildAllRows(input: AllRowsInput): AllRow[] {
  const { project, notes, events, now, showDone } = input
  const noteById = new Map(notes.map((note) => [note.id, note]))

  const tasksById = new Map<string, Task>()
  for (const task of input.projectTasks) tasksById.set(task.id, task)
  for (const task of input.allTasks) {
    if (tasksById.has(task.id)) continue
    const noteIds = [task.sourceNoteId, ...task.linkedNoteIds]
    if (noteIds.some((id) => id && noteById.has(id))) tasksById.set(task.id, task)
  }

  const tasksByNote = new Map<string, AllRow[]>()
  const orphanTasks: AllRow[] = []
  for (const task of tasksById.values()) {
    if (task.parentId !== null || task.archivedAt) continue
    const noteId = [task.sourceNoteId, ...task.linkedNoteIds].find((id) => id && noteById.has(id))
    const parent = noteId ? noteById.get(noteId) : undefined
    const row: AllRow = {
      key: `task:${task.id}`,
      type: 'task',
      id: task.id,
      title: task.title,
      emoji: null,
      parentNoteId: parent?.id ?? null,
      start: task.startDate ?? null,
      due: task.dueDate,
      status: null,
      isDone: isTaskDone(task, project),
      task,
      note: null,
      taskSummary: null,
      event: null
    }
    if (parent) tasksByNote.set(parent.id, [...(tasksByNote.get(parent.id) ?? []), row])
    else orphanTasks.push(row)
  }

  const visible = (row: AllRow): boolean => showDone || !row.isDone

  const noteRows = notes.map((note) => {
    const children = (tasksByNote.get(note.id) ?? []).toSorted(byDue)
    const open = children.filter((child) => !child.isDone)
    const dated = open.length > 0 ? open : children
    const isDone = children.length > 0 && open.length === 0
    const row: AllRow = {
      key: `note:${note.id}`,
      type: 'note',
      id: note.id,
      title: note.title,
      emoji: note.emoji,
      parentNoteId: null,
      start: earliest(dated.map((child) => child.start ?? child.due)),
      due: latest(dated.map((child) => child.due)),
      status: children.length === 0 ? null : isDone ? 'done' : 'active',
      isDone,
      task: null,
      note,
      taskSummary: children.length ? { open: open.length, total: children.length } : null,
      event: null
    }
    return { row, children }
  })

  const eventRows = events.map<AllRow>((event) => {
    const start = new Date(event.startAt)
    const end = event.endAt ? new Date(event.endAt) : start
    const isDone = end < now
    return {
      key: `event:${event.id}`,
      type: 'event',
      id: event.id,
      title: event.title,
      emoji: null,
      parentNoteId: null,
      start,
      due: end,
      status: isDone ? 'past' : 'upcoming',
      isDone,
      task: null,
      note: null,
      taskSummary: null,
      event
    }
  })

  const top = [
    ...noteRows.filter(({ row }) => visible(row)),
    ...orphanTasks.filter(visible).map((row) => ({ row, children: [] as AllRow[] })),
    ...eventRows.filter(visible).map((row) => ({ row, children: [] as AllRow[] }))
  ].toSorted((a, b) => byDue(a.row, b.row))

  return top.flatMap(({ row, children }) => [row, ...children.filter(visible)])
}

/** Flat sort. A row without a due date stays last in both directions. */
export function sortAllRows(rows: readonly AllRow[], sort: AllSort): AllRow[] {
  const sign = sort.dir === 'asc' ? 1 : -1
  return rows.toSorted((a, b) => {
    if (sort.key === 'title') return sign * a.title.localeCompare(b.title)
    if (!a.due) return b.due ? 1 : 0
    if (!b.due) return -1
    return sign * (a.due.getTime() - b.due.getTime())
  })
}
