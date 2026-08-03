/**
 * Types for the Todoist CSV import transform.
 *
 * Pure data shapes — no electron / fs / db dependencies.
 */

import type { ImportMessage } from '../messages.ts'

/** One CSV data row, typed from the 15 Todoist columns. */
export interface TodoistRow {
  type: 'task' | 'note' | 'section' | 'meta' | ''
  content: string
  description: string
  priority: number
  indent: number
  date: string
  dateLang: string
  timezone: string
  deadline: string
  rowNumber: number
}

/** A planned task, with parent wired via temp ids and mapped Memry fields. */
export interface TaskPlan {
  tempId: string
  parentTempId: string | null
  title: string
  description: string | null
  priority: 0 | 2 | 3 | 4
  position: number
  dueDate: string | null
  dueTime: string | null
}

export interface ProjectPlan {
  name: string
}

export interface ImportWarning extends ImportMessage {
  row?: number
}

export interface ImportStats {
  rows: number
  tasks: number
  subtasks: number
  withDueDate: number
  comments: number
  sectionsFlattened: number
  skipped: number
}

export interface ImportPlan {
  project: ProjectPlan
  tasks: TaskPlan[]
  warnings: ImportWarning[]
  stats: ImportStats
  sampleTitles: string[]
}
