/**
 * Single source of truth for what a reminder row looks like on the wire.
 *
 * Four outbound sites must agree — reminder-handler.ts's `buildPushPayload`
 * and `seedUnclocked`, reminder-sync.ts's `serialize`, and manifest-check.ts's
 * reminder block. A mismatch between them reads as a spurious manifest
 * disagreement with the server, so they all call this. `buildPushPayload` is
 * the one that decides the bytes on the wire: push-coordinator.ts's
 * `resolvePushPayload` rebuilds every non-delete payload through it before
 * encryption, and falls back to the queued `serialize` output only when the
 * row no longer exists locally.
 *
 * A fifth strip exists at lib/reminders.ts's `deleteReminder`, which removes
 * `triggeredAt` from the delete snapshot by hand. It deliberately does NOT go
 * through here and does not need to: `resolvePushPayload` returns delete
 * payloads verbatim, and `applyDelete` reads only the clock out of them.
 *
 * Everything removed here is DEVICE-LOCAL:
 *
 * - `triggeredAt` records that THIS device showed the OS notification. A synced
 *   value makes a device that never displayed the reminder believe it already
 *   had, silently swallowing the notification.
 * - `status: 'triggered'` is the same fact in another column — it only means
 *   THIS device's scheduler fired. Normalized to 'pending'. Real user intent
 *   ('dismissed' / 'snoozed') syncs unchanged.
 * - `remindAt` on an ANCHORED `note_date` row is DERIVED, per device, from the
 *   note's date pill. `computeRemindAt` (packages/shared/src/date-mention.ts)
 *   resolves in the host OS timezone on purpose, so each device fires at its
 *   own local 09:00 — two devices in different timezones derive different
 *   instants for the same pill. Now that these rows share a deterministic id,
 *   syncing the value would make the devices contend over it: every note write
 *   would flip it, and the losing device's reconciler would see
 *   `row.remindAt !== want.remindAt` and call `update()`, which resets `status`
 *   and destroys a dismiss. The note content that the value is derived FROM
 *   already syncs via CRDT, so every device re-derives its own correct time;
 *   only the user's intent (status / dismissedAt / snoozedUntil) needs to
 *   travel.
 *
 *   The `anchorId` conjunct is load-bearing, not defensive. Only anchored rows
 *   are reconciler-owned. An UNANCHORED `note_date` row is ordinary user
 *   intent with a user-supplied time — the CLI's `reminder create note_date`
 *   has no `--anchor-id` flag, and lib/reminders.ts's `createReminder` never
 *   writes `anchorId` at all — and nothing derives or recreates it. Stripping
 *   its `remindAt` would sync a reminder with no time.
 */
interface OutboundReminderRow {
  targetType?: unknown
  anchorId?: unknown
  status?: unknown
  remindAt?: unknown
  triggeredAt?: unknown
}

export function toOutboundReminderPayload<T extends OutboundReminderRow>(
  row: T
): Record<string, unknown> {
  const { triggeredAt: _triggeredAt, ...syncable } = row
  const payload: Record<string, unknown> = {
    ...syncable,
    status: syncable.status === 'triggered' ? 'pending' : syncable.status
  }
  if (payload.targetType === 'note_date' && payload.anchorId) delete payload.remindAt
  return payload
}
