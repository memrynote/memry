/**
 * Single source of truth for what a reminder row looks like on the wire.
 *
 * Four outbound sites must agree — reminder-handler.ts's `buildPushPayload`
 * and `seedUnclocked`, reminder-sync.ts's `serialize`, and manifest-check.ts's
 * reminder block. A mismatch between them reads as a spurious manifest
 * disagreement with the server, so they all call this.
 *
 * Everything removed here is DEVICE-LOCAL:
 *
 * - `triggeredAt` records that THIS device showed the OS notification. A synced
 *   value makes a device that never displayed the reminder believe it already
 *   had, silently swallowing the notification.
 * - `status: 'triggered'` is the same fact in another column — it only means
 *   THIS device's scheduler fired. Normalized to 'pending'. Real user intent
 *   ('dismissed' / 'snoozed') syncs unchanged.
 * - `remindAt` on a `note_date` row is DERIVED, per device, from the note's
 *   date pill. `computeRemindAt` (packages/shared/src/date-mention.ts) resolves
 *   in the host OS timezone on purpose, so each device fires at its own local
 *   09:00 — two devices in different timezones derive different instants for
 *   the same pill. Now that these rows share a deterministic id, syncing the
 *   value would make the devices contend over it: every note write would flip
 *   it, and the losing device's reconciler would see `row.remindAt !==
 *   want.remindAt` and call `update()`, which resets `status` and destroys a
 *   dismiss. The note content that the value is derived FROM already syncs via
 *   CRDT, so every device re-derives its own correct time; only the user's
 *   intent (status / dismissedAt / snoozedUntil) needs to travel.
 */
interface OutboundReminderRow {
  targetType?: unknown
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
  if (payload.targetType === 'note_date') delete payload.remindAt
  return payload
}
