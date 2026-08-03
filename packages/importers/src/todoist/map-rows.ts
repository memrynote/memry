import type { ImportPlan, ImportWarning, TaskPlan, TodoistRow } from './types.ts'
import { IMPORT_MESSAGE_CODES } from '../messages.ts'
import { todoistPriorityToMemry } from './priority.ts'
import { resolveDueDate } from './dates.ts'
import { commentToMarkdown } from './attachments.ts'

export interface MapOptions {
  now: Date
}

/** Transform parsed Todoist rows into a single-project import plan. */
export function mapRows(rows: TodoistRow[], projectName: string, { now }: MapOptions): ImportPlan {
  const tasks: TaskPlan[] = []
  const warnings: ImportWarning[] = []
  const stack: TaskPlan[] = [] // index = indent level
  let lastTask: TaskPlan | null = null
  let position = 0
  let comments = 0
  let sectionsFlattened = 0
  let skipped = 0
  let withDueDate = 0
  let seq = 0

  const name = projectName.trim() || 'Imported Todoist Project'

  for (const row of rows) {
    if (row.type === 'meta') continue

    if (row.type === 'section') {
      sectionsFlattened++
      warnings.push({
        row: row.rowNumber,
        code: IMPORT_MESSAGE_CODES.todoistSectionFlattened,
        message: `Section "${row.content.trim()}" flattened`,
        params: { section: row.content.trim() }
      })
      lastTask = null
      stack.length = 0
      continue
    }

    if (row.type === 'note') {
      if (!lastTask) {
        skipped++
        warnings.push({
          row: row.rowNumber,
          code: IMPORT_MESSAGE_CODES.todoistOrphanComment,
          message: 'Comment with no preceding task skipped'
        })
        continue
      }
      const md = commentToMarkdown(row.content)
      if (md) {
        lastTask.description = lastTask.description ? `${lastTask.description}\n\n${md}` : md
        comments++
      }
      continue
    }

    if (row.type !== 'task') continue

    // title
    let title = row.content.trim()
    if (!title) {
      title = '(untitled)'
      warnings.push({
        row: row.rowNumber,
        code: IMPORT_MESSAGE_CODES.todoistEmptyTitle,
        message: 'Task with empty content imported as (untitled)'
      })
    }

    // priority
    if (row.priority < 1 || row.priority > 4) {
      warnings.push({
        row: row.rowNumber,
        code: IMPORT_MESSAGE_CODES.todoistUnknownPriority,
        message: `Unknown priority ${row.priority} → none`,
        params: { priority: row.priority }
      })
    }
    const priority = todoistPriorityToMemry(row.priority)

    // due date (DATE, fallback DEADLINE)
    let dueDate: string | null = null
    let dueTime: string | null = null
    if (row.date.trim()) {
      const r = resolveDueDate(row.date, { now, lang: row.dateLang })
      if (r) {
        dueDate = r.date
        dueTime = r.time
      } else {
        warnings.push({
          row: row.rowNumber,
          code: IMPORT_MESSAGE_CODES.todoistUnparsedDate,
          message: `Could not parse date "${row.date.trim()}"`,
          params: { date: row.date.trim() }
        })
      }
    }
    if (!dueDate && row.deadline.trim()) {
      const r = resolveDueDate(row.deadline, { now, lang: 'en' })
      if (r) {
        dueDate = r.date
        dueTime = r.time
      }
    }
    if (dueDate) withDueDate++

    // hierarchy via INDENT
    const indent = Math.max(1, row.indent)
    let parentTempId: string | null = null
    if (indent > 1) {
      const parent = stack[indent - 1]
      if (parent) parentTempId = parent.tempId
      else
        warnings.push({
          row: row.rowNumber,
          code: IMPORT_MESSAGE_CODES.todoistSubtaskNoParent,
          message: `Sub-task "${title}" has no parent at indent ${indent - 1}; imported top-level`,
          params: { title, indent: indent - 1 }
        })
    }

    const taskPlan: TaskPlan = {
      tempId: `t${seq++}`,
      parentTempId,
      title,
      description: row.description.trim() || null,
      priority,
      position: position++,
      dueDate,
      dueTime
    }
    tasks.push(taskPlan)
    stack[indent] = taskPlan
    stack.length = indent + 1 // drop deeper levels
    lastTask = taskPlan
  }

  const subtasks = tasks.filter((t) => t.parentTempId !== null).length
  return {
    project: { name },
    tasks,
    warnings,
    stats: {
      rows: rows.length,
      tasks: tasks.length,
      subtasks,
      withDueDate,
      comments,
      sectionsFlattened,
      skipped
    },
    sampleTitles: tasks.slice(0, 5).map((t) => t.title)
  }
}
