import { noteReminderSyncId } from '@memry/contracts/reminder-types'
import { toOutboundReminderPayload } from '@memry/sync-client/reminder-outbound'

import type { VaultDb } from '@/db/index'
import { withVaultTransaction } from '@/db/tx'
import { createLogger } from '@/lib/logger'
import type { NoteOpsContext } from '@/features/notes/note-ops'
import { bumpClock } from '@/sync/outbox'

const log = createLogger('Reminders')

/**
 * Note reminders (issue #2111), the mobile half of a record desktop already
 * owns.
 *
 * Two rules shape everything here.
 *
 * 1. **The stored payload is synced truth ONLY.** Desktop keeps `triggeredAt`
 *    and `status: 'triggered'` in the same row it syncs and strips them on the
 *    way out, which works there because desktop merges an incoming payload
 *    field by field. Mobile has no per-type handler: `applyRecordItems`
 *    overwrites `sync_items.payload` VERBATIM with whatever arrived, so a
 *    device-local field parked inside the payload is destroyed by the next pull
 *    touching that reminder — silently, because the cursor advances anyway.
 *    Mobile therefore never writes one, and needs no strip step because there
 *    is nothing to strip.
 *
 * 2. **The OS pending-notification list is the only device-local store.**
 *    Schedules are keyed by `identifier === reminder.id`, so the list is a
 *    complete, crash-proof record of what this device holds — exactly the local
 *    table we would otherwise have had to add, migrate and keep in step with
 *    both the OS and the database. `reconcileReminders` is the ONE function
 *    that schedules or cancels anything.
 *
 * `targetType: 'note_date'` rows are never read, replaced or deleted here. They
 * are owned by desktop's note-content reconciler, their `remindAt` is derived
 * per device from a date pill, and mobile touching one would sync a value that
 * makes two desktops contend and reset each other's dismissals
 * (`reminder-outbound.ts`).
 */

// ---------------------------------------------------------------------------
// Instants
// ---------------------------------------------------------------------------

declare const instantBrand: unique symbol

/**
 * An ISO-8601 UTC instant, produced from a local `Date` via `.toISOString()`.
 *
 * Branded because the reminder wire format is a STRING and this app has already
 * been burned once by writing epoch ms where the desktop schema declared a
 * string (`NotePayload.createdAt`): every phone-edited note failed `safeParse`
 * on the desktop and was skipped without retry. The brand makes that class of
 * bug a compile error — the only way to obtain one is `toInstant`.
 */
export type Instant = string & { readonly [instantBrand]: true }

export function toInstant(date: Date): Instant {
  return date.toISOString() as Instant
}

/** Parse at the boundary. `null` on anything that is not a readable instant. */
export function fromInstant(value: unknown): Date | null {
  if (typeof value !== 'string') return null
  const ms = Date.parse(value)
  return Number.isFinite(ms) ? new Date(ms) : null
}

// ---------------------------------------------------------------------------
// Domain types
// ---------------------------------------------------------------------------

export type ReminderTarget = 'note' | 'journal'

/**
 * The four states a reminder can be in from this device's point of view.
 *
 * A union rather than a status string plus a pile of booleans: "amber", "was
 * due" and "should the OS hold a notification for this" are all one question,
 * and a boolean pair can express states that cannot exist.
 *
 * `at` is the EFFECTIVE instant — `snoozedUntil ?? remindAt`. A snooze issued on
 * the desktop syncs, so reading `remindAt` alone would ring this phone at the
 * original time the user already pushed away.
 *
 * INVARIANT: `kind === 'scheduled' | 'snoozed'` ⟺ the reconciler wants an OS
 * notification for this row. That equivalence is the whole scheduling rule;
 * there is no second predicate anywhere.
 */
export type ReminderState =
  | { kind: 'scheduled'; at: Date }
  | { kind: 'snoozed'; at: Date }
  | { kind: 'overdue'; at: Date }
  | { kind: 'dismissed'; at: Date }

/**
 * A note reminder as this app understands it — the DOMAIN type.
 *
 * Deliberately not the wire shape: `remindAt` is a `Date`, `state` is derived,
 * and the desktop-only highlight columns are absent. The stored payload keeps
 * every one of those fields untouched; they just do not belong on the surface
 * handed to a React component.
 */
export interface NoteReminder {
  readonly id: string
  readonly noteId: string
  readonly targetType: ReminderTarget
  readonly remindAt: Date
  readonly snoozedUntil: Date | null
  readonly title: string | null
  readonly note: string | null
  /** Derived on read from `status` + the effective instant vs. now. Never stored. */
  readonly state: ReminderState
}

/** `NoteReminder | null` flattened into exactly what a row or sheet renders. */
export interface ReminderBadge {
  readonly label: string
  readonly trailing: string | null
  /** SINGLE derivation of the desktop amber-bell rule. */
  readonly amber: boolean
}

export type ReminderDelivery =
  /** The OS is holding a dated notification for this reminder. */
  | 'scheduled'
  /** Saved and syncing; this device will show nothing. */
  | 'permission-denied'
  /** Saved; the time has already passed, so there is nothing to schedule. */
  | 'in-the-past'
  /** Saved; the device's pending-notification budget is full right now. */
  | 'device-limit'
  /** Saved; no notification module (simulator, test, stale dev client). */
  | 'unavailable'

/**
 * Every branch carries the saved reminder.
 *
 * Permission is a DELIVERY outcome, not a save outcome — the type makes it
 * impossible to write a call site that discards the reminder because the OS
 * said no.
 */
export interface SetReminderResult {
  readonly reminder: NoteReminder
  readonly delivery: ReminderDelivery
}

export type ReminderPermission = 'granted' | 'denied' | 'unavailable'

/** One entry the OS is holding, parsed into domain values at the boundary. */
export interface ScheduledReminder {
  readonly reminderId: string
  readonly noteId: string
  readonly at: Date
}

/** What the reconciler asks the OS to hold. Content is built here, not there. */
export interface ScheduleRequest {
  readonly reminderId: string
  readonly noteId: string
  readonly vaultId: string
  readonly at: Date
  readonly title: string
  readonly body: string
}

/**
 * The OS scheduler, as an interface.
 *
 * Named so the reconciler can be driven by a fake in a unit test — the cases
 * that matter (a stale entry at the wrong time, an entry for a reminder that no
 * longer exists) are invisible in a database and obvious in a call log. The
 * real implementation is `reminder-notifications.ts`, the only file in the app
 * that imports `expo-notifications`.
 */
export interface ReminderScheduler {
  /** Never prompts. Prompting is a user-initiated act; see `setNoteReminder`. */
  permission(): Promise<ReminderPermission>
  /** Prompts only when the user has not been asked yet. */
  request(): Promise<ReminderPermission>
  list(): Promise<ScheduledReminder[]>
  schedule(request: ScheduleRequest): Promise<'ok' | 'denied' | 'unavailable'>
  cancel(reminderId: string): Promise<void>
}

export interface ReconcileReport {
  readonly scheduled: number
  readonly cancelled: number
  /** Wanted, but over the device budget. */
  readonly deferred: number
  /**
   * WHICH ones were deferred, not just how many.
   *
   * `setNoteReminder` has to tell the user "saved, but this device is full"
   * about the reminder they just picked, and the count alone cannot answer
   * that. The alternative is a second round trip to the OS list right after the
   * reconciler already read it.
   */
  readonly deferredIds: readonly string[]
  readonly permission: ReminderPermission
}

export interface ReminderPreset {
  readonly key: 'later-today' | 'this-evening' | 'tomorrow' | 'next-week'
  readonly label: string
  readonly at: Date
}

/** The reconciler needs no outbox: it only reads rows and talks to the OS. */
export type ReminderContext = Pick<NoteOpsContext, 'db' | 'vaultId'>

// ---------------------------------------------------------------------------
// Wire type
// ---------------------------------------------------------------------------

/**
 * The stored `sync_items.payload` for a `reminder`, exactly as desktop writes
 * it (`ReminderSyncPayloadSchema`).
 *
 * Index signature per the mobile payload rule: read verbatim, mutate only our
 * own fields, write the whole object back, so a newer desktop's unknown fields
 * survive a mobile edit untouched.
 *
 * `status` omits `'triggered'` while the wire schema allows it, and
 * `triggeredAt` is absent entirely. Deliberate asymmetry: mobile must READ a
 * `'triggered'` leaked by an older desktop build tolerantly, and must never
 * WRITE one. The narrowed type enforces that at compile time instead of at a
 * runtime strip anyone could forget to call.
 */
interface ReminderPayload {
  targetType?: string
  targetId?: string
  remindAt?: string
  anchorId?: string | null
  highlightText?: string | null
  highlightStart?: number | null
  highlightEnd?: number | null
  title?: string | null
  note?: string | null
  status?: 'pending' | 'dismissed' | 'snoozed'
  dismissedAt?: string | null
  snoozedUntil?: string | null
  clock?: Record<string, number>
  createdAt?: string
  modifiedAt?: string
  [unknownFieldsFromNewerClients: string]: unknown
}

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

function asTarget(value: unknown): ReminderTarget | null {
  return value === 'note' || value === 'journal' ? value : null
}

/**
 * A stored payload as a domain reminder, or `null` if this module does not own
 * it.
 *
 * `note_date`, `highlight` and `task` rows fall out here, which is what makes
 * "this module never touches a `note_date` row" a property of the type rather
 * than of a comment: there is no code path that produces any other value.
 */
function toReminder(id: string, payload: ReminderPayload, now: Date): NoteReminder | null {
  const targetType = asTarget(payload.targetType)
  const noteId = payload.targetId
  const remindAt = fromInstant(payload.remindAt)
  if (!targetType || typeof noteId !== 'string' || !remindAt) return null

  return {
    id,
    noteId,
    targetType,
    remindAt,
    snoozedUntil: fromInstant(payload.snoozedUntil),
    title: typeof payload.title === 'string' ? payload.title : null,
    note: typeof payload.note === 'string' ? payload.note : null,
    state: deriveState(remindAt, fromInstant(payload.snoozedUntil), payload.status, now)
  }
}

/**
 * The only place a reminder's state is decided.
 *
 * A `'triggered'` status from an older desktop build is read as time like any
 * other — it only ever meant "some device's scheduler fired", which says
 * nothing about this one — and is never written back.
 */
function deriveState(
  remindAt: Date,
  snoozedUntil: Date | null,
  status: unknown,
  now: Date
): ReminderState {
  const at = snoozedUntil ?? remindAt
  if (status === 'dismissed') return { kind: 'dismissed', at }
  if (at.getTime() <= now.getTime()) return { kind: 'overdue', at }
  if (status === 'snoozed' && snoozedUntil) return { kind: 'snoozed', at }
  return { kind: 'scheduled', at }
}

function parsePayload(raw: string | null): ReminderPayload | null {
  if (!raw) return null
  try {
    return JSON.parse(raw) as ReminderPayload
  } catch {
    log.warn('Reminder payload is not JSON; skipping')
    return null
  }
}

/** Every live note/journal reminder in the vault, oldest effective time first. */
export async function readLiveReminders(db: VaultDb, now: Date): Promise<NoteReminder[]> {
  const rows = await db.getAllAsync<{ id: string; payload: string | null }>(
    `SELECT id, payload FROM sync_items WHERE type = 'reminder' AND deleted_at IS NULL`
  )
  const reminders: NoteReminder[] = []
  for (const row of rows) {
    const payload = parsePayload(row.payload)
    if (!payload) continue
    const reminder = toReminder(row.id, payload, now)
    if (reminder) reminders.push(reminder)
  }
  return reminders.sort((a, b) => a.state.at.getTime() - b.state.at.getTime())
}

/**
 * The one live reminder on a note, or null. Reads `sync_items`; no network, no
 * OS.
 *
 * A dismissed reminder reads as no reminder — the user silenced it on some
 * device and the bell should say so. An active one wins over an overdue one;
 * with the deterministic id there is normally exactly one row anyway.
 */
export async function readNoteReminder(
  db: VaultDb,
  noteId: string,
  now: Date = new Date()
): Promise<NoteReminder | null> {
  const mine = (await readLiveReminders(db, now)).filter((r) => r.noteId === noteId)
  return (
    mine.find((r) => r.state.kind === 'scheduled' || r.state.kind === 'snoozed') ??
    mine.filter((r) => r.state.kind === 'overdue').at(-1) ??
    null
  )
}

async function readStoredPayload(db: VaultDb, id: string): Promise<ReminderPayload | null> {
  // No `deleted_at IS NULL`: a tombstoned row's payload — and its CLOCK — is
  // exactly what a re-add has to reuse.
  const row = await db.getFirstAsync<{ payload: string | null }>(
    'SELECT payload FROM sync_items WHERE id = ?',
    [id]
  )
  return parsePayload(row?.payload ?? null)
}

// ---------------------------------------------------------------------------
// Presentation (pure: no db, no OS, no clock of its own)
// ---------------------------------------------------------------------------

function pad(value: number): string {
  return String(value).padStart(2, '0')
}

function timeOfDay(at: Date): string {
  return `${pad(at.getHours())}:${pad(at.getMinutes())}`
}

function sameDay(a: Date, b: Date): boolean {
  return (
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate()
  )
}

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'] as const
const MONTHS = [
  'Jan',
  'Feb',
  'Mar',
  'Apr',
  'May',
  'Jun',
  'Jul',
  'Aug',
  'Sep',
  'Oct',
  'Nov',
  'Dec'
] as const

/** "Today 09:00" · "Tomorrow 09:00" · "Mon 09:00" · "12 Mar 09:00". */
export function formatReminderTime(at: Date, now: Date): string {
  const tomorrow = new Date(now)
  tomorrow.setDate(tomorrow.getDate() + 1)
  if (sameDay(at, now)) return `Today ${timeOfDay(at)}`
  if (sameDay(at, tomorrow)) return `Tomorrow ${timeOfDay(at)}`
  const days = (at.getTime() - now.getTime()) / 86_400_000
  if (days > 0 && days < 7) return `${WEEKDAYS[at.getDay()]} ${timeOfDay(at)}`
  return `${at.getDate()} ${MONTHS[at.getMonth()]} ${timeOfDay(at)}`
}

/** "just now" · "3 hours ago" · "2 days ago". */
export function formatTimeAgo(at: Date, now: Date): string {
  const minutes = Math.floor((now.getTime() - at.getTime()) / 60_000)
  if (minutes < 1) return 'just now'
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? '' : 's'} ago`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours} hour${hours === 1 ? '' : 's'} ago`
  const days = Math.floor(hours / 24)
  return `${days} day${days === 1 ? '' : 's'} ago`
}

/**
 * The More-sheet row, derived from the row and the clock.
 *
 * Takes `now` rather than reading the clock so the derivation is pure and a
 * timezone test can drive it. The cost is that an open screen can hold an amber
 * bell a minute after it should have gone plain, which is not worth a ticking
 * timer on the note screen.
 */
export function describeReminder(
  reminder: NoteReminder | null,
  now: Date,
  notificationsOff = false
): ReminderBadge {
  if (!reminder || reminder.state.kind === 'dismissed') {
    return { label: 'Remind me…', trailing: null, amber: false }
  }
  if (reminder.state.kind === 'overdue') {
    return {
      label: 'Reminder — was due',
      trailing: formatTimeAgo(reminder.state.at, now),
      amber: false
    }
  }
  return {
    label: 'Reminder',
    // Said at the moment it matters, and kept being said: a reminder this
    // device can never ring is otherwise indistinguishable from one that will.
    trailing: notificationsOff ? 'Notifications off' : formatReminderTime(reminder.state.at, now),
    amber: true
  }
}

function at(now: Date, dayOffset: number, hour: number): Date {
  const date = new Date(now)
  date.setDate(date.getDate() + dayOffset)
  date.setHours(hour, 0, 0, 0)
  return date
}

/**
 * The four quick picks, as a pure function of `now`.
 *
 * A preset whose time has already passed is dropped rather than silently
 * rolled forward — "This evening" that means tomorrow evening is a lie the row
 * cannot tell the user.
 */
export function reminderPresets(now: Date): readonly ReminderPreset[] {
  const laterToday = new Date(now)
  laterToday.setMinutes(0, 0, 0)
  laterToday.setHours(laterToday.getHours() + 4)

  const presets: ReminderPreset[] = []
  if (sameDay(laterToday, now)) {
    presets.push({ key: 'later-today', label: 'Later today', at: laterToday })
  }
  const evening = at(now, 0, 20)
  if (evening.getTime() > now.getTime()) {
    presets.push({ key: 'this-evening', label: 'This evening', at: evening })
  }
  presets.push({ key: 'tomorrow', label: 'Tomorrow', at: at(now, 1, 9) })
  // Next Monday, 09:00. `getDay()` is 0 for Sunday.
  const day = now.getDay()
  const untilMonday = day === 0 ? 1 : 8 - day
  presets.push({ key: 'next-week', label: 'Next week', at: at(now, untilMonday, 9) })
  // Chronological, not declaration order: after 16:00 "Later today" is LATER
  // than "This evening", and a list that reads out of order looks broken.
  return presets.sort((x, y) => x.at.getTime() - y.at.getTime())
}

// ---------------------------------------------------------------------------
// Writing
// ---------------------------------------------------------------------------

/**
 * Last step before `JSON.stringify`, always.
 *
 * On a payload this module built it is the identity function — nothing here
 * ever writes `triggeredAt` or `status: 'triggered'`. It runs anyway so that a
 * PULLED payload carrying one from an older desktop build is normalized when
 * mobile next edits it, and so that a device-local field desktop adds later is
 * inherited for free instead of drifting.
 */
function serialize(payload: ReminderPayload): string {
  return JSON.stringify(toOutboundReminderPayload(payload))
}

async function upsertRow(
  ctx: NoteOpsContext,
  id: string,
  payload: ReminderPayload,
  now: number
): Promise<void> {
  bumpClock(payload as Record<string, unknown>, ctx.deviceId)
  const serialized = serialize(payload)
  await ctx.db.runAsync(
    `INSERT INTO sync_items (id, type, vault_id, updated_at, deleted_at, payload_state, payload)
     VALUES (?, 'reminder', ?, ?, NULL, 'full', ?)
     ON CONFLICT(id) DO UPDATE SET
       updated_at = excluded.updated_at,
       deleted_at = NULL,
       payload_state = 'full',
       payload = excluded.payload`,
    [id, ctx.vaultId, now, serialized]
  )
  await ctx.outbox.enqueueRecord('reminder', id, 'update', serialized)
}

async function tombstoneRow(ctx: NoteOpsContext, id: string, now: number): Promise<void> {
  const stored = await readStoredPayload(ctx.db, id)
  if (!stored) return
  bumpClock(stored as Record<string, unknown>, ctx.deviceId)
  const serialized = serialize(stored)
  // A tombstone, never a hard delete — same rule as a bookmark: deleting the
  // row locally makes the next pull treat the server's copy as new and the
  // reminder comes back.
  await ctx.db.runAsync(
    'UPDATE sync_items SET deleted_at = ?, updated_at = ?, payload = ? WHERE id = ?',
    [now, now, serialized, id]
  )
  await ctx.outbox.enqueueRecord('reminder', id, 'delete', serialized)
}

export interface SetReminderOptions {
  title?: string | null
  note?: string | null
  targetType?: ReminderTarget
  /** Injected in tests; production callers take the real OS scheduler. */
  scheduler?: ReminderScheduler
  now?: Date
}

/**
 * Set or replace the reminder on a note. Mirrors desktop's
 * `useSetOrReplaceReminder`: one reminder per note, a new pick replaces the old.
 *
 * The row and the queued push land FIRST, then the OS scheduler is reconciled.
 * A saved reminder with no notification is repaired by the next reconcile pass;
 * a notification with no row would be a ghost banner for a reminder the user
 * does not have.
 */
export async function setNoteReminder(
  ctx: NoteOpsContext,
  noteId: string,
  remindAt: Date,
  opts: SetReminderOptions = {}
): Promise<SetReminderResult> {
  const now = opts.now ?? new Date()
  const id = noteReminderSyncId(noteId)
  const stamp = now.getTime()

  // A desktop-created random-id reminder on this note is SUPERSEDED, not left
  // beside the new one — desktop resolves one-per-note the same way.
  const superseded = (await readLiveReminders(ctx.db, now))
    .filter((r) => r.noteId === noteId && r.id !== id)
    .map((r) => r.id)

  const payload: ReminderPayload = (await readStoredPayload(ctx.db, id)) ?? {
    createdAt: toInstant(now)
  }
  const targetType = opts.targetType ?? asTarget(payload.targetType) ?? 'note'
  payload.targetType = targetType
  payload.targetId = noteId
  payload.remindAt = toInstant(remindAt)
  payload.status = 'pending'
  payload.dismissedAt = null
  // A new time undoes a snooze: the user just said when they want this.
  payload.snoozedUntil = null
  if (opts.title !== undefined) payload.title = opts.title
  if (opts.note !== undefined) payload.note = opts.note
  payload.modifiedAt = toInstant(now)

  await withVaultTransaction(ctx.db, async () => {
    for (const staleId of superseded) await tombstoneRow(ctx, staleId, stamp)
    await upsertRow(ctx, id, payload, stamp)
  })

  // Built from what was just written rather than read back: the row is the
  // authority for every OTHER device, but this call already knows what it put
  // there, and a re-read would only introduce a way for the result to be null.
  const reminder: NoteReminder = {
    id,
    noteId,
    targetType,
    remindAt,
    snoozedUntil: null,
    title: payload.title ?? null,
    note: payload.note ?? null,
    state: deriveState(remindAt, null, 'pending', now)
  }

  // Asked HERE, at the moment the user confirmed a time — never at app start,
  // which is the most reliable way to earn a permanent denial.
  const scheduler = opts.scheduler ?? (await loadScheduler()) ?? undefined
  if (scheduler) await scheduler.request()
  const report = await reconcileReminders(ctx, scheduler, now)

  return { reminder, delivery: deliveryFor(reminder, report, now) }
}

function deliveryFor(reminder: NoteReminder, report: ReconcileReport, now: Date): ReminderDelivery {
  if (report.permission === 'unavailable') return 'unavailable'
  if (reminder.state.at.getTime() <= now.getTime()) return 'in-the-past'
  if (report.permission === 'denied') return 'permission-denied'
  if (report.deferredIds.includes(reminder.id)) return 'device-limit'
  return 'scheduled'
}

/**
 * Remove the reminder on a note: tombstone every row this module owns for it,
 * enqueue the deletes, cancel the notification.
 *
 * A delete, not a dismiss. Desktop models those separately and mobile ships the
 * one the More sheet offers; `status: 'dismissed'` is a status write away when
 * a surface needs it.
 */
export async function clearNoteReminder(
  ctx: NoteOpsContext,
  noteId: string,
  opts: { scheduler?: ReminderScheduler; now?: Date } = {}
): Promise<void> {
  const now = opts.now ?? new Date()
  const stamp = now.getTime()
  const ids = (await readLiveReminders(ctx.db, now))
    .filter((r) => r.noteId === noteId)
    .map((r) => r.id)
  if (ids.length === 0) return

  await withVaultTransaction(ctx.db, async () => {
    for (const id of ids) await tombstoneRow(ctx, id, stamp)
  })

  await reconcileReminders(ctx, opts.scheduler)
}

// ---------------------------------------------------------------------------
// The reconciler
// ---------------------------------------------------------------------------

/**
 * iOS holds at most 64 pending local notifications per app and SILENTLY drops
 * the rest. Silently is the hazard, so the cut is made here, with headroom for
 * anything else the app ever schedules. Reminders past the cut are deferred,
 * not lost: every pass re-cuts the list, so far reminders move into the budget
 * as near ones fire.
 */
export const DEVICE_BUDGET = 56

/** iOS truncates a long banner anyway; the DB field is never touched. */
const BODY_LIMIT = 200

/** Loaded lazily so this module has no static `expo-notifications` dependency. */
async function loadScheduler(): Promise<ReminderScheduler | null> {
  try {
    return (await import('./reminder-notifications')).notificationScheduler
  } catch (err) {
    log.warn('The notification module is unavailable', {
      error: err instanceof Error ? err.message : String(err)
    })
    return null
  }
}

/** Note titles for the reminders about to be scheduled, in one query per 100. */
async function readTitles(db: VaultDb, ids: string[]): Promise<Map<string, string>> {
  const titles = new Map<string, string>()
  for (let i = 0; i < ids.length; i += 100) {
    const chunk = ids.slice(i, i + 100)
    const rows = await db.getAllAsync<{ id: string; payload: string | null }>(
      `SELECT id, payload FROM sync_items
       WHERE type IN ('note', 'journal') AND id IN (${chunk.map(() => '?').join(',')})`,
      chunk
    )
    for (const row of rows) {
      if (!row.payload) continue
      try {
        const title = (JSON.parse(row.payload) as { title?: unknown }).title
        if (typeof title === 'string' && title.length > 0) titles.set(row.id, title)
      } catch {
        // A note whose payload will not parse still deserves a banner; it just
        // gets the fallback title.
      }
    }
  }
  return titles
}

/**
 * Make the OS scheduler agree with the database. THE only function in the app
 * that schedules or cancels a notification.
 *
 * Idempotent and safe to call concurrently: schedules are keyed by
 * `identifier === reminder.id`, so re-scheduling replaces a reminder's single
 * OS entry rather than adding a second one.
 *
 * Never throws. It runs from `AppState` listeners and sync callbacks, where a
 * rejection is an unhandled rejection nobody reads.
 */
export async function reconcileReminders(
  ctx: ReminderContext,
  scheduler?: ReminderScheduler,
  now: Date = new Date()
): Promise<ReconcileReport> {
  const idle = { scheduled: 0, cancelled: 0, deferred: 0, deferredIds: [] as string[] }
  try {
    const os = scheduler ?? (await loadScheduler())
    if (!os) return { ...idle, permission: 'unavailable' }

    const permission = await os.permission()
    if (permission !== 'granted') {
      // Cancel nothing: a denied permission means the list is already empty, and
      // if permission was revoked while banners were pending iOS has dropped
      // them itself. The rows are untouched and keep syncing.
      return { ...idle, permission }
    }

    const active = (await readLiveReminders(ctx.db, now)).filter(
      (r) => r.state.kind === 'scheduled' || r.state.kind === 'snoozed'
    )
    const want = active.slice(0, DEVICE_BUDGET)
    const deferredIds = active.slice(DEVICE_BUDGET).map((r) => r.id)
    const wanted = new Map(want.map((r) => [r.id, r]))

    const have = await os.list()
    const standing = new Set<string>()
    let cancelled = 0
    for (const entry of have) {
      const match = wanted.get(entry.reminderId)
      // (b) is the case a naive "schedule if missing" reconciler gets wrong: the
      // identifier still matches, so the entry LOOKS correct while holding a
      // stale time. The comparison is on the instant, not on identity.
      if (match && match.state.at.getTime() === entry.at.getTime()) {
        standing.add(entry.reminderId)
        continue
      }
      await os.cancel(entry.reminderId)
      cancelled += 1
    }

    const missing = want.filter((r) => !standing.has(r.id))
    const titles = await readTitles(
      ctx.db,
      missing.map((r) => r.noteId)
    )
    let scheduledCount = 0
    for (const reminder of missing) {
      const outcome = await os.schedule({
        reminderId: reminder.id,
        noteId: reminder.noteId,
        vaultId: ctx.vaultId,
        at: reminder.state.at,
        title: reminder.title ?? titles.get(reminder.noteId) ?? 'Memry',
        body: (reminder.note ?? 'Reminder').slice(0, BODY_LIMIT)
      })
      if (outcome === 'ok') scheduledCount += 1
    }

    return {
      scheduled: scheduledCount,
      cancelled,
      deferred: deferredIds.length,
      deferredIds,
      permission
    }
  } catch (err) {
    log.warn('Reconciling reminders failed', {
      error: err instanceof Error ? err.message : String(err)
    })
    return { ...idle, permission: 'unavailable' }
  }
}

/** Read the OS permission without prompting. `unavailable` off-device. */
export async function reminderPermission(): Promise<ReminderPermission> {
  const os = await loadScheduler()
  return os ? os.permission() : 'unavailable'
}

/**
 * Route a tapped banner back to its note. Returns an unsubscribe.
 *
 * Wrapped here so the shell has one module to import for everything reminders,
 * and so the `expo-notifications` import stays dynamic — a Node test that pulls
 * in this file never reaches it.
 */
export function onReminderTap(
  handler: (ref: { reminderId: string; noteId: string }) => void
): () => void {
  let live = true
  let off: (() => void) | null = null
  void import('./reminder-notifications')
    .then((mod) => {
      if (!live) return
      off = mod.onReminderTap(handler)
    })
    .catch((err: unknown) => {
      log.warn('Reminder tap routing is unavailable', {
        error: err instanceof Error ? err.message : String(err)
      })
    })
  return () => {
    live = false
    off?.()
  }
}
