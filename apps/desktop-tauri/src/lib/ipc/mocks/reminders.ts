import type { MockRouteMap } from './types'
import { mockId, mockTimestamp } from './types'

interface MockReminder {
  id: string
  title: string
  body: string
  dueAt: number
  noteId: string | null
  taskId: string | null
  completedAt: number | null
  snoozedUntil: number | null
  createdAt: number
  updatedAt: number
}

const reminders: MockReminder[] = [
  {
    id: 'reminder-1',
    title: 'Şirket demo prep',
    body: 'Prepare demo for customer call.',
    dueAt: mockTimestamp(1),
    noteId: null,
    taskId: null,
    completedAt: null,
    snoozedUntil: null,
    createdAt: mockTimestamp(3),
    updatedAt: mockTimestamp(1)
  },
  {
    id: 'reminder-2',
    title: 'Review PR #42',
    body: 'Review teammate PR before EOD.',
    dueAt: mockTimestamp(0),
    noteId: null,
    taskId: null,
    completedAt: null,
    snoozedUntil: null,
    createdAt: mockTimestamp(2),
    updatedAt: mockTimestamp(0)
  },
  {
    id: 'reminder-3',
    title: 'Submit expenses',
    body: 'Submit March expenses.',
    dueAt: mockTimestamp(-2),
    noteId: null,
    taskId: null,
    completedAt: null,
    snoozedUntil: null,
    createdAt: mockTimestamp(5),
    updatedAt: mockTimestamp(1)
  },
  {
    id: 'reminder-4',
    title: 'Call Anne',
    body: 'Weekly family call.',
    dueAt: mockTimestamp(-7),
    noteId: null,
    taskId: null,
    completedAt: null,
    snoozedUntil: null,
    createdAt: mockTimestamp(14),
    updatedAt: mockTimestamp(7)
  },
  {
    id: 'reminder-5',
    title: 'Refill prescription',
    body: 'Pick up at pharmacy.',
    dueAt: mockTimestamp(3),
    noteId: null,
    taskId: null,
    completedAt: mockTimestamp(0),
    snoozedUntil: null,
    createdAt: mockTimestamp(10),
    updatedAt: mockTimestamp(0)
  },
  {
    id: 'reminder-6',
    title: 'Plan sprint',
    body: 'Plan sprint for Memry-Tauri spike.',
    dueAt: mockTimestamp(2),
    noteId: null,
    taskId: null,
    completedAt: null,
    snoozedUntil: null,
    createdAt: mockTimestamp(4),
    updatedAt: mockTimestamp(1)
  }
]

export const remindersRoutes: MockRouteMap = {
  reminders_list: async () => reminders,
  reminders_list_due: async () => reminders.filter((r) => r.completedAt === null && r.dueAt <= Date.now()),
  reminders_get: async (args) => {
    const { id } = args as { id: string }
    const r = reminders.find((x) => x.id === id)
    if (!r) throw new Error(`Reminder ${id} not found`)
    return r
  },
  reminders_create: async (args) => {
    const input = args as Partial<MockReminder> & { title: string; dueAt: number }
    const now = Date.now()
    const r: MockReminder = {
      id: mockId('reminder'),
      title: input.title,
      body: input.body ?? '',
      dueAt: input.dueAt,
      noteId: input.noteId ?? null,
      taskId: input.taskId ?? null,
      completedAt: null,
      snoozedUntil: null,
      createdAt: now,
      updatedAt: now
    }
    reminders.unshift(r)
    return r
  },
  reminders_update: async (args) => {
    const { id, ...changes } = args as { id: string } & Partial<MockReminder>
    const r = reminders.find((x) => x.id === id)
    if (!r) throw new Error(`Reminder ${id} not found`)
    Object.assign(r, changes, { updatedAt: Date.now() })
    return r
  },
  reminders_complete: async (args) => {
    const { id } = args as { id: string }
    const r = reminders.find((x) => x.id === id)
    if (!r) throw new Error(`Reminder ${id} not found`)
    r.completedAt = Date.now()
    r.updatedAt = Date.now()
    return r
  },
  reminders_snooze: async (args) => {
    const { id, until } = args as { id: string; until: number }
    const r = reminders.find((x) => x.id === id)
    if (!r) throw new Error(`Reminder ${id} not found`)
    r.snoozedUntil = until
    r.dueAt = until
    r.updatedAt = Date.now()
    return r
  },
  reminders_delete: async (args) => {
    const { id } = args as { id: string }
    const idx = reminders.findIndex((r) => r.id === id)
    if (idx >= 0) reminders.splice(idx, 1)
    return { ok: true }
  }
}
