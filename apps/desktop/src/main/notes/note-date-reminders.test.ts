import { describe, it, expect, vi, beforeEach, afterEach, type Mock } from 'vitest'
import { syncNoteDateReminders } from './note-date-reminders'
import { serializeDateMentionToken } from '@memry/shared/date-mention'
import { createRemindersService, type RemindersService } from '@memry/app-core/reminders'
import type { ReminderSyncPayload } from '@memry/contracts/sync-payloads'
import {
  createTestDataDb,
  asClientDb,
  asSyncDb,
  type TestDatabaseResult
} from '@tests/utils/test-db'
import { makeCtx } from '@tests/utils/fixtures/sync-item-handlers'
import { reminderHandler } from '../sync/item-handlers/reminder-handler'

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

// note_date rows are DERIVED: every device re-runs this reconciler over its own
// CRDT-synced copy of the note. With reminders syncing, two writers target one
// logical row, so these use the REAL reminders service with its sync hook
// attached — a fake service cannot prove that a re-run enqueues nothing.
describe('syncNoteDateReminders sync convergence', () => {
  const markdown = `due ${remindingToken}`
  const deterministicId = 'rem_nd_note_1_dm_1'

  let testDb: TestDatabaseResult
  let onMutate: Mock
  let service: RemindersService

  beforeEach(() => {
    testDb = createTestDataDb()
    onMutate = vi.fn()
    service = createRemindersService(asClientDb(testDb.db), { onMutate })
  })

  afterEach(() => {
    testDb.close()
  })

  async function listRows(svc: RemindersService = service) {
    return (await svc.list({ targetType: 'note_date', targetId: 'note_1', limit: 1000 })).reminders
  }

  it('creates the reminder with a deterministic id', async () => {
    await syncNoteDateReminders('note_1', markdown, service)

    const rows = await listRows()
    expect(rows).toHaveLength(1)
    expect(rows[0].id).toBe(deterministicId)
  })

  /** What device A puts on the wire for the same pill, via the real push path. */
  async function pushFromDeviceA(): Promise<{ id: string; payload: ReminderSyncPayload }> {
    const deviceA = createTestDataDb()
    try {
      const serviceA = createRemindersService(asClientDb(deviceA.db))
      await syncNoteDateReminders('note_1', markdown, serviceA)
      const id = (await listRows(serviceA))[0].id
      const payload = JSON.parse(
        reminderHandler.buildPushPayload(asSyncDb(deviceA.db), id, 'device_a', 'create') as string
      ) as ReminderSyncPayload
      return { id, payload }
    } finally {
      deviceA.close()
    }
  }

  it('converges to one row when the same pill derived on another device syncs in', async () => {
    const { id: pushedId, payload } = await pushFromDeviceA()

    // This device already derived the same pill from the CRDT-synced note
    // content before A's row arrived; the handler then applies A's push.
    await syncNoteDateReminders('note_1', markdown, service)
    reminderHandler.applyUpsert(makeCtx(testDb), pushedId, payload, { device_a: 1 })

    const rows = await listRows()
    expect(rows).toHaveLength(1)
    expect(rows[0].id).toBe(deterministicId)
  })

  // The reverse arrival order, which is the one a fresh or long-offline device
  // actually hits: 'note' and 'reminder' share the same pull-apply rank and
  // note bodies land through a separate CRDT writeback, so A's reminder can
  // reach this device before the note content it is derived from.
  it('does not duplicate when the remote row arrives before this device reconciles', async () => {
    const { id: pushedId, payload } = await pushFromDeviceA()

    // A note_date row is owned by the local reconciler, so the handler refuses
    // to insert one rather than invent a remindAt it cannot derive yet.
    expect(reminderHandler.applyUpsert(makeCtx(testDb), pushedId, payload, { device_a: 1 })).toBe(
      'skipped'
    )
    expect(await listRows()).toHaveLength(0)
    expect(onMutate).not.toHaveBeenCalled()

    // The note content then lands over CRDT and the writeback reconciles: one
    // row, one enqueue — the legitimate first local derivation.
    await syncNoteDateReminders('note_1', markdown, service)
    expect(await listRows()).toHaveLength(1)
    expect(onMutate).toHaveBeenCalledTimes(1)
    expect(onMutate).toHaveBeenCalledWith('create', deterministicId)

    // Steady state: every later note write enqueues nothing.
    onMutate.mockClear()
    await syncNoteDateReminders('note_1', markdown, service)
    expect(onMutate).not.toHaveBeenCalled()
  })

  it('enqueues nothing on a re-run over unchanged markdown (loop guard)', async () => {
    await syncNoteDateReminders('note_1', markdown, service)
    onMutate.mockClear()

    await syncNoteDateReminders('note_1', markdown, service)

    expect(onMutate).not.toHaveBeenCalled()
  })

  it('keeps a dismissed status when the note is re-written', async () => {
    await syncNoteDateReminders('note_1', markdown, service)
    await service.dismiss(deterministicId)

    await syncNoteDateReminders('note_1', markdown, service)

    expect((await service.get(deterministicId))?.status).toBe('dismissed')
  })

  it('deletes the row and enqueues the delete when the pill is removed', async () => {
    await syncNoteDateReminders('note_1', markdown, service)
    onMutate.mockClear()

    await syncNoteDateReminders('note_1', 'no dates here', service)

    expect(await listRows()).toHaveLength(0)
    expect(onMutate).toHaveBeenCalledWith('delete', deterministicId, expect.any(String))
  })
})
