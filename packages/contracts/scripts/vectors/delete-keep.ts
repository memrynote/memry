/**
 * Class: keeping unseen text over a pulled delete (`delete-keep.json`, #3029).
 *
 * Chapter 05 §5.8, client behavior: before a client applies a note or journal
 * delete, it keeps local text the deleter cannot have seen as a new inbox item.
 * The generator records the real output of `keepsUnseenText` and
 * `deletedAtMs` for each case.
 *
 * Determinism: D1. Both functions are pure.
 */
import {
  DELETE_KEEP_SKEW_MS,
  deletedAtMs,
  keepsUnseenText,
  type UnseenTextFacts
} from '../../../sync-client/src/delete-keep.ts'
import { meta } from './shared'

const A = 'device-a'
const B = 'device-b'
// 2026-10-09T12:00:00Z
const DELETED_MS = 1_791_547_200_000
const DELETED_S = DELETED_MS / 1000

interface DeleteKeepSpec {
  name: string
  pins: string
  facts: UnseenTextFacts
}

const base: UnseenTextFacts = {
  bodyBlank: false,
  waitingChanges: false,
  localClock: { [A]: 4 },
  tombstoneClock: { [A]: 5 },
  deletedAt: DELETED_MS,
  lastLocalBodyAt: DELETED_MS - 3_600_000
}

const SPECS: DeleteKeepSpec[] = [
  {
    name: 'synced-text-is-not-kept',
    pins: 'text pushed an hour before the delete, nothing waiting, clock covered: the deleter saw it',
    facts: base
  },
  {
    name: 'never-pushed-body-is-not-kept-when-old',
    pins: 'no body push recorded and nothing waiting: nothing unseen',
    facts: { ...base, lastLocalBodyAt: null }
  },
  {
    name: 'waiting-change-is-kept',
    pins: 'a local change still queued for the server is unseen',
    facts: { ...base, waitingChanges: true }
  },
  {
    name: 'concurrent-clock-is-kept',
    pins: 'a record change the tombstone does not cover is unseen',
    facts: { ...base, localClock: { [A]: 4, [B]: 1 } }
  },
  {
    name: 'offline-create-is-kept',
    pins: 'a day created here, clock only from this device, is concurrent with a peer delete',
    facts: { ...base, localClock: { [B]: 1 }, lastLocalBodyAt: null }
  },
  {
    name: 'body-pushed-after-delete-is-kept',
    pins: 'the outbox won the race with the pull: text reached the server after the delete',
    facts: { ...base, lastLocalBodyAt: DELETED_MS + 5_000 }
  },
  {
    name: 'body-pushed-inside-skew-is-kept',
    pins: 'text that reached the server just before the delete may not have reached the deleter',
    facts: { ...base, lastLocalBodyAt: DELETED_MS - DELETE_KEEP_SKEW_MS }
  },
  {
    name: 'body-pushed-just-outside-skew-is-not-kept',
    pins: 'one ms past the slack counts as seen',
    facts: { ...base, lastLocalBodyAt: DELETED_MS - DELETE_KEEP_SKEW_MS - 1 }
  },
  {
    name: 'deleted-at-in-seconds',
    pins: 'desktop sends deletedAt in whole seconds; it is read as ms * 1000',
    facts: { ...base, deletedAt: DELETED_S, lastLocalBodyAt: DELETED_MS + 5_000 }
  },
  {
    name: 'deleted-at-in-seconds-old-push',
    pins: 'seconds are scaled, so an old push stays seen',
    facts: { ...base, deletedAt: DELETED_S }
  },
  {
    name: 'no-deleted-at',
    pins: 'without a delete time only rules 1 and 2 apply',
    facts: { ...base, deletedAt: null, lastLocalBodyAt: DELETED_MS + 5_000 }
  },
  {
    name: 'blank-body-is-never-kept',
    pins: 'nothing to keep',
    facts: { ...base, bodyBlank: true, waitingChanges: true, localClock: { [B]: 1 } }
  },
  {
    name: 'local-after-tombstone-is-not-kept',
    pins: 'a local clock strictly after the tombstone keeps the item itself (§5.8)',
    facts: { ...base, localClock: { [A]: 6 }, waitingChanges: true }
  },
  {
    name: 'clockless-row-uses-other-rules',
    pins: 'no local clock: the clock rule is silent, a waiting change still keeps',
    facts: { ...base, localClock: null, waitingChanges: true }
  },
  {
    name: 'clockless-tombstone-uses-other-rules',
    pins: 'a legacy tombstone with no clock: an old synced body is not kept',
    facts: { ...base, tombstoneClock: null }
  }
]

export function buildDeleteKeep(): Record<string, unknown> {
  const cases = SPECS.map((spec) => ({
    ...spec,
    expected: {
      keep: keepsUnseenText(spec.facts),
      deletedAtMs: spec.facts.deletedAt === null ? null : deletedAtMs(spec.facts.deletedAt)
    }
  }))

  return {
    meta: meta({
      class: 'delete-keep',
      chapter: 'docs/protocol/05-record-sync.md',
      implementation: 'packages/sync-client/src/delete-keep.ts',
      caseCount: cases.length
    }),
    skewMs: DELETE_KEEP_SKEW_MS,
    cases
  }
}
