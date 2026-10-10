import type { VectorClock } from '@memry/contracts/sync-api'
import { compare } from './vector-clock'

/**
 * Whether a pulled note or journal delete would erase text this device wrote
 * that the deleting device cannot have seen (#3029). When it would, the client
 * keeps that text as a new inbox item before it applies the delete; the delete
 * itself still wins (chapter 05 §5.8).
 *
 * A body edit travels as CRDT updates and never moves the record clock, so the
 * clock alone cannot answer this. The text counts as unseen when any of these
 * holds:
 *
 * 1. `waitingChanges`: a local change to the item has not reached the server
 *    (a queued record or body push, or a body push the server refused).
 * 2. The local record clock is concurrent with the tombstone: this device made
 *    a record change the deleter never received.
 * 3. `lastLocalBodyAt` is no earlier than the delete minus
 *    `DELETE_KEEP_SKEW_MS`: this device's own text reached the server (desktop
 *    records the push confirmation) or was written (the core, which pushes only
 *    after its pull) at about the time of the delete or after it. The slack
 *    absorbs clock skew between the two devices.
 *
 * Text pushed well before the delete, with nothing waiting and a clock the
 * tombstone covers, is text the deleter could see: no copy. A blank body never
 * makes a copy, and neither does a local clock strictly after the tombstone
 * (that device keeps the item, §5.8).
 */
export const DELETE_KEEP_SKEW_MS = 60_000

export interface UnseenTextFacts {
  bodyBlank: boolean
  waitingChanges: boolean
  localClock: VectorClock | null
  tombstoneClock: VectorClock | null
  /** The tombstone's `deletedAt` as it came off the wire. */
  deletedAt: number | null
  /** Epoch ms of this device's latest own body text, as defined in rule 3. */
  lastLocalBodyAt: number | null
}

/**
 * `deletedAt` in epoch ms. Chapter 04 says ms, and the core sends ms, but
 * desktop has always sent whole seconds; a value too small to be a ms time
 * after 1973 is read as seconds.
 */
export function deletedAtMs(deletedAt: number): number {
  return deletedAt < 100_000_000_000 ? deletedAt * 1000 : deletedAt
}

export function keepsUnseenText(facts: UnseenTextFacts): boolean {
  if (facts.bodyBlank) return false
  const order =
    facts.localClock && facts.tombstoneClock
      ? compare(facts.localClock, facts.tombstoneClock)
      : null
  if (order === 'after') return false
  if (facts.waitingChanges || order === 'concurrent') return true
  if (facts.deletedAt === null || facts.lastLocalBodyAt === null) return false
  return facts.lastLocalBodyAt >= deletedAtMs(facts.deletedAt) - DELETE_KEEP_SKEW_MS
}
