/**
 * What the note screen may honestly say about a note's edits (#2115).
 *
 * Every state here is derived from something the app can actually observe:
 * the guest→host handoff (`dirty`), this note's rows in the durable outbox
 * (`queued`), the HTTP adapter's online flag, whether a push pass is in flight
 * and whether writes are parked. Nothing infers a server round trip that did
 * not happen — "synced" means the queue for THIS note is empty, which is only
 * ever true because the server accepted and the rows were deleted.
 *
 * `synced` is the resting state and renders nothing. A permanently visible
 * badge is the thing this indicator is explicitly not (restraint; DESIGN.md).
 */
export type NoteSaveStatus = 'synced' | 'saving' | 'syncing' | 'pending' | 'offline'

export interface NoteSaveInputs {
  /**
   * Edits the guest may still be holding.
   *
   * Set when a local update arrives and cleared when the debounced
   * `controls.flush()` resolves — i.e. the window in which the WebView's own
   * outbound batch has not necessarily reached the host yet. What the host HAS
   * received is already durable before this flag is even read.
   */
  dirty: boolean
  /** This note's rows in the outbox. Non-zero means the server has not taken them. */
  queued: number
  online: boolean
  /** A drain pass is running right now. */
  pushing: boolean
  /** Writes are parked — read-only vault or version gate. The queue waits. */
  parked: boolean
}

export function noteSaveStatus(input: NoteSaveInputs): NoteSaveStatus {
  if (input.dirty) return 'saving'
  if (input.queued === 0) return 'synced'
  // Offline outranks a running pass: a drain that started before the radio
  // dropped is not going to land, and "Syncing…" over a dead connection is the
  // one thing an honest indicator must never say.
  if (!input.online) return 'offline'
  // Parked outranks it for the same reason — the pass reads the policy and
  // returns without sending a row.
  if (input.parked) return 'pending'
  if (input.pushing) return 'syncing'
  return 'pending'
}

export interface NoteSaveStatusText {
  /** The visible word. Kept to two or three, and never a count. */
  text: string
  /** The full sentence VoiceOver reads; the visible text alone under-explains. */
  accessibilityLabel: string
}

export function describeNoteSaveStatus(status: NoteSaveStatus): NoteSaveStatusText | null {
  switch (status) {
    case 'synced':
      return null
    case 'saving':
      return { text: 'Saving…', accessibilityLabel: 'Saving your changes on this device.' }
    case 'syncing':
      return {
        text: 'Syncing…',
        accessibilityLabel: 'Saved on this device. Sending to your other devices.'
      }
    case 'offline':
      return {
        text: 'Offline · saved here',
        accessibilityLabel:
          'Saved on this device. Offline, so it will sync when you are back online.'
      }
    case 'pending':
      return {
        text: 'Saved on this device',
        accessibilityLabel: 'Saved on this device. Not sent to your other devices yet.'
      }
  }
}
