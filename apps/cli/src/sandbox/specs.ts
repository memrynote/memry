// Shapes of the content data in content/*.ts. Offsets are days relative to
// today (negative = past); see clock.ts.
import type { Body } from './body.ts'
import type { AssetName } from './context.ts'

export interface NoteSpec {
  key: string
  title: string
  folder: string
  tags?: string[]
  /** Sidebar icon, stored in note_metadata (post/notes.ts). */
  emoji?: string
  /** Committed assets attached to this note before its body is written. */
  assets?: AssetName[]
  /** Small files written straight into the note's attachment folder. */
  generated?: Array<{ name: string; mimeType: string; content: string }>
  properties?: (b: Body) => Record<string, unknown>
  body: (b: Body) => string
  /** Days ago the note was created and last edited. */
  created: number
  modified: number
}

export interface JournalSpec {
  day: number
  tags?: string[]
  properties: Record<string, unknown>
  body: (b: Body) => string
}

export interface RepeatSpec {
  frequency: 'daily' | 'weekly' | 'monthly'
  interval: number
  daysOfWeek?: number[]
  dayOfMonth?: number
}

export interface TaskSpec {
  key: string
  title: string
  /** Project key from content/projects; omitted = the built-in Inbox project. */
  project?: string
  status?: string
  parent?: string
  priority?: 0 | 1 | 2 | 3 | 4
  due?: number
  dueTime?: string
  start?: number
  tags?: string[]
  description?: string
  /** Note keys shown as related notes. */
  notes?: string[]
  canvases?: string[]
  /** Person note key: sets the `Waiting on` field of the `#waiting` tag. */
  waitingOn?: string
  /** Note key, or `journal:<offset>`, holding this task's `{task:id}` line. */
  source?: string
  repeat?: RepeatSpec
  /** Days ago the task was completed. */
  completed?: number
  archived?: boolean
  /** Days ago the task was created. */
  created: number
}

export interface EventSpec {
  key: string
  title: string
  day: number
  /** `HH:MM` local; omitted = all-day. */
  start?: string
  end?: string
  /** All-day span in days (default 1). */
  days?: number
  location?: string
  description?: string
}

export interface ProjectSpec {
  key: string
  name: string
  description: string
  color: string
  icon: string
  /** Status names in board order; the last one is the done column. */
  statuses?: string[]
  archived?: boolean
  homeNote?: string
}
