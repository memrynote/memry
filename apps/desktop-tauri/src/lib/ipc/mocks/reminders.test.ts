import { describe, it, expect } from 'vitest'

import { remindersRoutes } from './reminders'

describe('remindersRoutes', () => {
  it('reminders_list returns at least 5 fixtures', async () => {
    const list = (await remindersRoutes.reminders_list!(undefined)) as Array<{ id: string }>
    expect(list.length).toBeGreaterThanOrEqual(5)
  })

  it('reminders_list_due returns only reminders that are overdue now', async () => {
    const list = (await remindersRoutes.reminders_list_due!(undefined)) as Array<{
      dueAt: number
    }>
    expect(list.every((r) => r.dueAt <= Date.now())).toBe(true)
  })

  it('reminders_get returns the reminder', async () => {
    const r = (await remindersRoutes.reminders_get!({ id: 'reminder-1' })) as { id: string }
    expect(r.id).toBe('reminder-1')
  })

  it('reminders_get rejects unknown id', async () => {
    await expect(remindersRoutes.reminders_get!({ id: 'missing' })).rejects.toThrow(/not found/i)
  })

  it('reminders_create adds a new reminder', async () => {
    const created = (await remindersRoutes.reminders_create!({
      title: 'Water plants',
      dueAt: Date.now() + 3_600_000
    })) as { id: string; title: string }
    expect(created.id).toMatch(/^reminder-\d+/)
  })

  it('reminders_complete marks as done', async () => {
    const updated = (await remindersRoutes.reminders_complete!({ id: 'reminder-2' })) as {
      completedAt: number | null
    }
    expect(updated.completedAt).not.toBeNull()
  })

  it('reminders_snooze bumps dueAt', async () => {
    const until = Date.now() + 86_400_000
    const updated = (await remindersRoutes.reminders_snooze!({
      id: 'reminder-3',
      until
    })) as { dueAt: number }
    expect(updated.dueAt).toBe(until)
  })

  it('reminders_delete removes it', async () => {
    const created = (await remindersRoutes.reminders_create!({
      title: 'Doomed',
      dueAt: Date.now() + 1000
    })) as { id: string }
    const res = (await remindersRoutes.reminders_delete!({ id: created.id })) as {
      ok: boolean
    }
    expect(res.ok).toBe(true)
  })
})
