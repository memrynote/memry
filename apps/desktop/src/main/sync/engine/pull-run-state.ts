import type { SyncTimer } from '@memry/sync-client/sync-timer'
import type { RunAppliedCursors } from './run-applied-cursors'
import type { PullLatencyTrace } from './sync-latency-telemetry'

/** What one pull run carries from page to page. */
export interface PullRunState {
  timer: SyncTimer
  startTime: number
  pulledCount: number
  totalConflictsResolved: number
  applied: RunAppliedCursors
  crdtNoteIds: string[]
  accessJwt: string
  vaultKey: Uint8Array
  latency: PullLatencyTrace
  /** Set when the run stopped on a page it could not apply — no success finalize. */
  refused?: boolean
  /** The run started from cursor 0: it applies no purged tombstone (#2302). */
  fromZero?: boolean
}
