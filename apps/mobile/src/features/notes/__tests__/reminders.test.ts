import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import {
  clearNoteReminder,
  describeReminder,
  readNoteReminder,
  reconcileReminders,
  reminderPresets,
  setNoteReminder,
  type ReminderPermission,
  type ReminderScheduler,
  type ScheduledReminder,
  type ScheduleRequest
} from '@/features/notes/reminders'

import { openTestVault, seedNote, type TestVault } from './vault-db-harness'

/**
 * A stand-in for the iOS pending-notification list.
 *
 * Keyed by identifier and REPLACING on a second schedule, because that is the
 * property the whole reconciler rests on — a fake that appended instead would
 * make every idempotency assertion here vacuous.
 */
function fakeScheduler(
  entries: ScheduledReminder[] = [],
  permission: ReminderPermission = 'granted'
) {
  const held = new Map(entries.map((entry) => [entry.reminderId, entry]))
  const scheduled: ScheduleRequest[] = []
  const cancelled: string[] = []
  const scheduler: ReminderScheduler = {
    permission: () => Promise.resolve(permission),
    request: () => Promise.resolve(permission),
    list: () => Promise.resolve([...held.values()]),
    schedule: (request) => {
      scheduled.push(request)
      held.set(request.reminderId, {
        reminderId: request.reminderId,
        noteId: request.noteId,
        at: request.at
      })
      return Promise.resolve('ok')
    },
    cancel: (reminderId) => {
      cancelled.push(reminderId)
      held.delete(reminderId)
      return Promise.resolve()
    }
  }
  return { scheduler, scheduled, cancelled, held }
}

/** Insert a reminder the way a pull would: full payload, no queue row. */
function seedReminder(
  vault: TestVault,
  input: {
    id: string
    targetId: string
    remindAt: string
    targetType?: string
    status?: string
    snoozedUntil?: string
    triggeredAt?: string
    deleted?: boolean
  }
): void {
  const payload: Record<string, unknown> = {
    targetType: input.targetType ?? 'note',
    targetId: input.targetId,
    remindAt: input.remindAt,
    status: input.status ?? 'pending',
    clock: { 'device-remote': 1 },
    createdAt: '2026-01-01T00:00:00.000Z'
  }
  if (input.snoozedUntil) payload.snoozedUntil = input.snoozedUntil
  if (input.triggeredAt) payload.triggeredAt = input.triggeredAt
  void vault.db.runAsync(
    `INSERT INTO sync_items (id, type, vault_id, updated_at, deleted_at, payload_state, payload)
     VALUES (?, 'reminder', 'vault-1', ?, ?, 'full', ?)`,
    [input.id, 1_700_000_000_000, input.deleted ? 1_700_000_000_000 : null, JSON.stringify(payload)]
  )
}

/**
 * LOCAL wall-clock instants, not UTC literals.
 *
 * `describeReminder` renders in the device's timezone, so a UTC literal makes
 * "Today 18:00" a fact about the CI box rather than about the code — the exact
 * shape of vacuous timezone test this repo has been bitten by before.
 * Tue 10 March 2026, so `next-week` lands on the following Monday.
 */
const NOW = new Date(2026, 2, 10, 12, 0, 0, 0)
const SOON = new Date(2026, 2, 10, 18, 0, 0, 0)
const LATER = new Date(2026, 2, 11, 9, 0, 0, 0)
const YESTERDAY = new Date(2026, 2, 9, 9, 0, 0, 0)
const TWO_DAYS_ON = new Date(2026, 2, 12, 12, 0, 0, 0)

function writtenPayloads(vault: TestVault): Record<string, unknown>[] {
  return vault.outboxRows().map((row) => row.payload as Record<string, unknown>)
}

describe('reminders — writing', () => {
  let vault: TestVault

  beforeEach(() => {
    vault = openTestVault()
  })
  afterEach(() => vault.close())

  it('derives the id from the note so two offline devices mint one row', async () => {
    const os = fakeScheduler()
    await setNoteReminder(vault.ctx, 'n1', SOON, { scheduler: os.scheduler, now: NOW })

    const rows = vault.outboxRows()
    expect(rows).toHaveLength(1)
    expect(rows[0].itemId).toBe('rem_note_n1')
    expect(rows[0].itemType).toBe('reminder:update')
    expect(rows[0].payload).toMatchObject({
      targetType: 'note',
      targetId: 'n1',
      remindAt: SOON.toISOString(),
      status: 'pending'
    })
  })

  it('a second pick replaces in place: same id, climbing clock', async () => {
    const os = fakeScheduler()
    await setNoteReminder(vault.ctx, 'n1', SOON, { scheduler: os.scheduler, now: NOW })
    await setNoteReminder(vault.ctx, 'n1', LATER, { scheduler: os.scheduler, now: NOW })

    const rows = vault.outboxRows()
    // One row, not two: `enqueueRecord` supersedes this device's earlier pending
    // rows for the same id.
    expect(rows).toHaveLength(1)
    expect(rows[0].itemId).toBe('rem_note_n1')
    expect((rows[0].payload as { clock: Record<string, number> }).clock['device-a']).toBe(2)
    expect((rows[0].payload as { remindAt: string }).remindAt).toBe(LATER.toISOString())
  })

  it('re-adding after a removal keeps the clock climbing', async () => {
    const os = fakeScheduler()
    await setNoteReminder(vault.ctx, 'n1', SOON, { scheduler: os.scheduler, now: NOW })
    await clearNoteReminder(vault.ctx, 'n1', { scheduler: os.scheduler, now: NOW })
    await setNoteReminder(vault.ctx, 'n1', LATER, { scheduler: os.scheduler, now: NOW })

    const rows = vault.outboxRows()
    expect(rows).toHaveLength(1)
    expect(rows[0].itemType).toBe('reminder:update')
    // A fresh `{device-a: 1}` on the re-add would read as OLDER than the delete
    // on every peer, and the reminder would simply never come back.
    expect((rows[0].payload as { clock: Record<string, number> }).clock['device-a']).toBe(3)
    expect(await readNoteReminder(vault.ctx.db, 'n1', NOW)).not.toBeNull()
  })

  it('removing tombstones the row rather than deleting it', async () => {
    const os = fakeScheduler()
    await setNoteReminder(vault.ctx, 'n1', SOON, { scheduler: os.scheduler, now: NOW })
    await clearNoteReminder(vault.ctx, 'n1', { scheduler: os.scheduler, now: NOW })

    const row = await vault.db.getFirstAsync<{ deleted_at: number | null }>(
      `SELECT deleted_at FROM sync_items WHERE id = 'rem_note_n1'`
    )
    // A hard delete makes the next pull treat the server's copy as new and the
    // reminder comes back.
    expect(row?.deleted_at).not.toBeNull()
    expect(vault.outboxRows().at(-1)?.itemType).toBe('reminder:delete')
    expect(await readNoteReminder(vault.ctx.db, 'n1', NOW)).toBeNull()
  })

  it('supersedes a desktop-minted random-id reminder on the same note', async () => {
    seedReminder(vault, { id: 'rem_abc123', targetId: 'n1', remindAt: LATER.toISOString() })
    const os = fakeScheduler()
    await setNoteReminder(vault.ctx, 'n1', SOON, { scheduler: os.scheduler, now: NOW })

    const rows = vault.outboxRows()
    expect(rows.map((row) => `${row.itemId}:${row.op}`).sort()).toEqual([
      'rem_abc123:delete',
      'rem_note_n1:upsert'
    ])
    const live = await readNoteReminder(vault.ctx.db, 'n1', NOW)
    expect(live?.id).toBe('rem_note_n1')
  })

  it('never writes triggeredAt or a triggered status, even when it read one', async () => {
    seedReminder(vault, {
      id: 'rem_note_n1',
      targetId: 'n1',
      remindAt: LATER.toISOString(),
      status: 'triggered',
      triggeredAt: '2026-03-09T09:00:00.000Z'
    })
    seedReminder(vault, {
      id: 'rem_legacy',
      targetId: 'n1',
      remindAt: LATER.toISOString(),
      status: 'triggered',
      triggeredAt: '2026-03-09T09:00:00.000Z'
    })
    const os = fakeScheduler()
    await setNoteReminder(vault.ctx, 'n1', SOON, { scheduler: os.scheduler, now: NOW })
    await clearNoteReminder(vault.ctx, 'n1', { scheduler: os.scheduler, now: NOW })

    const payloads = writtenPayloads(vault)
    expect(payloads.length).toBeGreaterThan(0)
    for (const payload of payloads) {
      expect(payload).not.toHaveProperty('triggeredAt')
      expect(payload.status).not.toBe('triggered')
    }
  })

  it('leaves note_date rows completely alone', async () => {
    seedReminder(vault, {
      id: 'rem_nd_n1_anchor',
      targetId: 'n1',
      remindAt: LATER.toISOString(),
      targetType: 'note_date'
    })
    const os = fakeScheduler()
    await setNoteReminder(vault.ctx, 'n1', SOON, { scheduler: os.scheduler, now: NOW })
    await clearNoteReminder(vault.ctx, 'n1', { scheduler: os.scheduler, now: NOW })

    const touched = vault.outboxRows().map((row) => row.itemId)
    expect(touched).not.toContain('rem_nd_n1_anchor')
    const row = await vault.db.getFirstAsync<{ deleted_at: number | null }>(
      `SELECT deleted_at FROM sync_items WHERE id = 'rem_nd_n1_anchor'`
    )
    expect(row?.deleted_at).toBeNull()
    // And it is never scheduled either: the reconciler reads the same filter.
    expect(os.scheduled.map((request) => request.reminderId)).not.toContain('rem_nd_n1_anchor')
  })

  it('keeps unknown fields a newer desktop wrote', async () => {
    void vault.db.runAsync(
      `INSERT INTO sync_items (id, type, vault_id, updated_at, payload_state, payload)
       VALUES ('rem_note_n1', 'reminder', 'vault-1', 1, 'full', ?)`,
      [
        JSON.stringify({
          targetType: 'note',
          targetId: 'n1',
          remindAt: LATER.toISOString(),
          status: 'pending',
          repeatRule: 'weekly'
        })
      ]
    )
    const os = fakeScheduler()
    await setNoteReminder(vault.ctx, 'n1', SOON, { scheduler: os.scheduler, now: NOW })
    expect(vault.outboxRows()[0].payload).toMatchObject({ repeatRule: 'weekly' })
  })

  it('reports a save the OS refused to ring as saved, not failed', async () => {
    const os = fakeScheduler([], 'denied')
    const result = await setNoteReminder(vault.ctx, 'n1', SOON, {
      scheduler: os.scheduler,
      now: NOW
    })
    expect(result.delivery).toBe('permission-denied')
    expect(result.reminder.remindAt).toEqual(SOON)
    expect(await readNoteReminder(vault.ctx.db, 'n1', NOW)).not.toBeNull()
  })

  it('a time already past is saved and reported as such', async () => {
    const os = fakeScheduler()
    const result = await setNoteReminder(vault.ctx, 'n1', YESTERDAY, {
      scheduler: os.scheduler,
      now: NOW
    })
    expect(result.delivery).toBe('in-the-past')
    expect(os.scheduled).toHaveLength(0)
  })
})

describe('reminders — the reconciler', () => {
  let vault: TestVault

  beforeEach(() => {
    vault = openTestVault()
  })
  afterEach(() => vault.close())

  it('schedules a reminder created on another device', async () => {
    seedNote(vault, { id: 'n1', title: 'Aurelie' })
    seedReminder(vault, { id: 'rem_note_n1', targetId: 'n1', remindAt: SOON.toISOString() })
    const os = fakeScheduler()

    const report = await reconcileReminders(vault.ctx, os.scheduler, NOW)

    expect(report.scheduled).toBe(1)
    expect(os.scheduled[0]).toMatchObject({
      reminderId: 'rem_note_n1',
      noteId: 'n1',
      vaultId: 'vault-1',
      at: SOON,
      // The note's own title, not a generic string: the banner has to say which
      // note it is about.
      title: 'Aurelie'
    })
  })

  it('cancels one deleted on another device', async () => {
    seedReminder(vault, {
      id: 'rem_note_n1',
      targetId: 'n1',
      remindAt: SOON.toISOString(),
      deleted: true
    })
    const os = fakeScheduler([{ reminderId: 'rem_note_n1', noteId: 'n1', at: SOON }])

    const report = await reconcileReminders(vault.ctx, os.scheduler, NOW)

    expect(report.cancelled).toBe(1)
    expect(os.cancelled).toEqual(['rem_note_n1'])
    expect(os.scheduled).toHaveLength(0)
  })

  it('catches a same-id entry holding a stale time', async () => {
    seedReminder(vault, { id: 'rem_note_n1', targetId: 'n1', remindAt: LATER.toISOString() })
    // The identifier still matches, so a "schedule if missing" reconciler would
    // leave this standing at the OLD time.
    const os = fakeScheduler([{ reminderId: 'rem_note_n1', noteId: 'n1', at: SOON }])

    const report = await reconcileReminders(vault.ctx, os.scheduler, NOW)

    expect(os.cancelled).toEqual(['rem_note_n1'])
    expect(report.scheduled).toBe(1)
    expect(os.scheduled[0].at).toEqual(LATER)
  })

  it('leaves an entry that already agrees exactly alone', async () => {
    seedReminder(vault, { id: 'rem_note_n1', targetId: 'n1', remindAt: SOON.toISOString() })
    const os = fakeScheduler([{ reminderId: 'rem_note_n1', noteId: 'n1', at: SOON }])

    const report = await reconcileReminders(vault.ctx, os.scheduler, NOW)

    expect(report).toMatchObject({ scheduled: 0, cancelled: 0, deferred: 0 })
  })

  it('repairs a crash between the row write and the schedule', async () => {
    seedReminder(vault, { id: 'rem_note_n1', targetId: 'n1', remindAt: SOON.toISOString() })
    const os = fakeScheduler()

    expect((await reconcileReminders(vault.ctx, os.scheduler, NOW)).scheduled).toBe(1)
  })

  it('cancels a notification whose row never landed', async () => {
    const os = fakeScheduler([{ reminderId: 'rem_note_ghost', noteId: 'ghost', at: SOON }])

    const report = await reconcileReminders(vault.ctx, os.scheduler, NOW)

    expect(report.cancelled).toBe(1)
    expect(os.held.size).toBe(0)
  })

  it('does not back-fire a reminder that came due while the app was closed', async () => {
    seedReminder(vault, {
      id: 'rem_note_n1',
      targetId: 'n1',
      remindAt: YESTERDAY.toISOString()
    })
    const os = fakeScheduler()

    const report = await reconcileReminders(vault.ctx, os.scheduler, NOW)

    expect(report.scheduled).toBe(0)
    // It is not lost — the row reads as overdue and the More sheet says so.
    const reminder = await readNoteReminder(vault.ctx.db, 'n1', NOW)
    expect(reminder?.state.kind).toBe('overdue')
  })

  it('honours a snooze issued on another device', async () => {
    seedReminder(vault, {
      id: 'rem_note_n1',
      targetId: 'n1',
      remindAt: SOON.toISOString(),
      status: 'snoozed',
      snoozedUntil: LATER.toISOString()
    })
    const os = fakeScheduler()

    await reconcileReminders(vault.ctx, os.scheduler, NOW)

    // Scheduling `remindAt` would ring the phone at the time the user already
    // pushed away.
    expect(os.scheduled[0].at).toEqual(LATER)
  })

  it('schedules nothing for a reminder dismissed on another device', async () => {
    seedReminder(vault, {
      id: 'rem_note_n1',
      targetId: 'n1',
      remindAt: SOON.toISOString(),
      status: 'dismissed'
    })
    const os = fakeScheduler([{ reminderId: 'rem_note_n1', noteId: 'n1', at: SOON }])

    const report = await reconcileReminders(vault.ctx, os.scheduler, NOW)

    expect(report.scheduled).toBe(0)
    expect(os.cancelled).toEqual(['rem_note_n1'])
  })

  it('caps the device at its budget and defers the rest, soonest first', async () => {
    for (let i = 0; i < 60; i += 1) {
      seedReminder(vault, {
        id: `rem_note_n${i}`,
        targetId: `n${i}`,
        // One per hour, ascending, so the cut is unambiguous.
        remindAt: new Date(NOW.getTime() + (i + 1) * 3_600_000).toISOString()
      })
    }
    const os = fakeScheduler()

    const report = await reconcileReminders(vault.ctx, os.scheduler, NOW)

    expect(report.scheduled).toBe(56)
    expect(report.deferred).toBe(4)
    expect(report.deferredIds).toEqual([
      'rem_note_n56',
      'rem_note_n57',
      'rem_note_n58',
      'rem_note_n59'
    ])
  })

  it('touches nothing when the permission is denied', async () => {
    seedReminder(vault, { id: 'rem_note_n1', targetId: 'n1', remindAt: SOON.toISOString() })
    const os = fakeScheduler([{ reminderId: 'rem_note_n1', noteId: 'n1', at: SOON }], 'denied')

    const report = await reconcileReminders(vault.ctx, os.scheduler, NOW)

    expect(report).toMatchObject({ scheduled: 0, cancelled: 0, permission: 'denied' })
    expect(os.cancelled).toHaveLength(0)
  })

  it('reports rather than throws when the OS call fails', async () => {
    seedReminder(vault, { id: 'rem_note_n1', targetId: 'n1', remindAt: SOON.toISOString() })
    const os = fakeScheduler()
    const broken: ReminderScheduler = {
      ...os.scheduler,
      list: () => Promise.reject(new Error('no notification module'))
    }

    // It runs from AppState listeners, where a rejection is an unhandled one.
    await expect(reconcileReminders(vault.ctx, broken, NOW)).resolves.toMatchObject({
      scheduled: 0,
      permission: 'unavailable'
    })
  })
})

describe('reminders — presentation', () => {
  it('is amber only while the reminder is still ahead', async () => {
    const vault = openTestVault()
    try {
      seedReminder(vault, { id: 'rem_note_n1', targetId: 'n1', remindAt: SOON.toISOString() })
      const ahead = await readNoteReminder(vault.db, 'n1', NOW)
      expect(describeReminder(ahead, NOW)).toEqual({
        label: 'Reminder',
        trailing: 'Today 18:00',
        amber: true
      })
      const behind = await readNoteReminder(vault.db, 'n1', TWO_DAYS_ON)
      expect(describeReminder(behind, TWO_DAYS_ON)).toMatchObject({
        label: 'Reminder — was due',
        amber: false
      })
    } finally {
      vault.close()
    }
  })

  it('says notifications are off instead of a time this device will not honour', async () => {
    const vault = openTestVault()
    try {
      seedReminder(vault, { id: 'rem_note_n1', targetId: 'n1', remindAt: SOON.toISOString() })
      const reminder = await readNoteReminder(vault.db, 'n1', NOW)
      expect(describeReminder(reminder, NOW, true).trailing).toBe('Notifications off')
    } finally {
      vault.close()
    }
  })

  it('offers no reminder at all as the invitation to set one', () => {
    expect(describeReminder(null, NOW)).toEqual({
      label: 'Remind me…',
      trailing: null,
      amber: false
    })
  })

  it('drops a preset whose time has already gone', () => {
    // 22:00 local: neither "later today" nor "this evening" can still happen.
    const lateNight = new Date(2026, 2, 10, 22, 0, 0, 0)
    expect(reminderPresets(lateNight).map((preset) => preset.key)).toEqual([
      'tomorrow',
      'next-week'
    ])
  })

  it('lists presets in the order they happen, not the order they are declared', () => {
    // At 19:00 "Later today" (23:00) is LATER than "This evening" (20:00).
    const evening = new Date(2026, 2, 10, 19, 0, 0, 0)
    expect(reminderPresets(evening).map((preset) => preset.key)).toEqual([
      'this-evening',
      'later-today',
      'tomorrow',
      'next-week'
    ])
  })

  it('every preset it does offer is in the future', () => {
    const morning = new Date(2026, 2, 10, 8, 0, 0, 0)
    const presets = reminderPresets(morning)
    expect(presets.map((preset) => preset.key)).toEqual([
      'later-today',
      'this-evening',
      'tomorrow',
      'next-week'
    ])
    for (const preset of presets) {
      expect(preset.at.getTime()).toBeGreaterThan(morning.getTime())
    }
    // Next week is the next Monday; 10 March 2026 is a Tuesday.
    expect(presets[3].at.getDay()).toBe(1)
  })
})
