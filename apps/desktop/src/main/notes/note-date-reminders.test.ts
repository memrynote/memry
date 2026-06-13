import { describe, it, expect, vi } from 'vitest'
import { syncNoteDateReminders } from './note-date-reminders'
import { serializeDateMentionToken } from '@memry/shared/date-mention'

function fakeService(existing: any[] = []) {
  const rows = [...existing]
  return {
    rows,
    list: vi.fn(async () => ({ reminders: rows, total: rows.length, hasMore: false })),
    create: vi.fn(async (input: any) => {
      const row = { id: `rem_${rows.length}`, status: 'pending', ...input }
      rows.push(row)
      return row
    }),
    update: vi.fn(async (input: any) => {
      const r = rows.find((x) => x.id === input.id)
      Object.assign(r, input)
      return r
    }),
    delete: vi.fn(async (id: string) => {
      const i = rows.findIndex((x) => x.id === id)
      if (i >= 0) rows.splice(i, 1)
      return true
    })
  }
}

const remindingToken = serializeDateMentionToken({
  anchorId: 'dm_1',
  dateISO: '2026-06-20T09:00:00.000Z',
  hasTime: true,
  dateFormat: 'relative',
  remind: '1h',
  timeFormat: 'system'
})

describe('syncNoteDateReminders', () => {
  it('creates a note_date reminder for a new reminding pill', async () => {
    const svc = fakeService()
    await syncNoteDateReminders('note_1', `due ${remindingToken}`, svc as any)
    expect(svc.create).toHaveBeenCalledTimes(1)
    expect(svc.rows[0]).toMatchObject({
      targetType: 'note_date',
      targetId: 'note_1',
      anchorId: 'dm_1',
      remindAt: '2026-06-20T08:00:00.000Z'
    })
  })

  it('does NOT create a row for a bare (remind:none) date', async () => {
    const bare = serializeDateMentionToken({
      anchorId: 'dm_2',
      dateISO: '2026-06-20T09:00:00.000Z',
      hasTime: false,
      dateFormat: 'relative',
      remind: 'none',
      timeFormat: 'system'
    })
    const svc = fakeService()
    await syncNoteDateReminders('note_1', bare, svc as any)
    expect(svc.create).not.toHaveBeenCalled()
  })

  it('fires a day-level offset at 09:00 local, N days before', async () => {
    // Local date so the assertion is timezone-independent.
    const dayLevel = serializeDateMentionToken({
      anchorId: 'dm_3',
      dateISO: new Date(2026, 5, 20, 0, 0, 0).toISOString(),
      hasTime: false,
      dateFormat: 'relative',
      remind: '1d',
      timeFormat: 'system'
    })
    const svc = fakeService()
    await syncNoteDateReminders('note_1', dayLevel, svc as any)
    const r = new Date(svc.rows[0].remindAt)
    expect(r.getHours()).toBe(9)
    expect(r.getDate()).toBe(19)
  })

  it('deletes the row when the pill is removed from the note', async () => {
    const svc = fakeService([
      { id: 'rem_x', targetType: 'note_date', targetId: 'note_1', anchorId: 'dm_1', remindAt: 'x' }
    ])
    await syncNoteDateReminders('note_1', 'no dates here', svc as any)
    expect(svc.delete).toHaveBeenCalledWith('rem_x')
  })

  it('updates remindAt when the pill date changes', async () => {
    const svc = fakeService([
      {
        id: 'rem_x',
        targetType: 'note_date',
        targetId: 'note_1',
        anchorId: 'dm_1',
        remindAt: '2000-01-01T00:00:00.000Z'
      }
    ])
    await syncNoteDateReminders('note_1', `due ${remindingToken}`, svc as any)
    expect(svc.update).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'rem_x', remindAt: '2026-06-20T08:00:00.000Z' })
    )
  })
})
