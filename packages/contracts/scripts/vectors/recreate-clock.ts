/**
 * Class: re-create clock seeding (`recreate-clock.json`, #2409).
 *
 * Chapter 05 §5.8 and chapter 06 §6.1: a write that creates an id, or first
 * clocks a clockless row, ticks from `merge(local, tombstone)` when the
 * client knows the id's last tombstone clock, so the re-create happens
 * strictly after the delete. The generator records the real output of
 * `recreateBaseClock` and of the mint desktop runs on top of it,
 * `incrementClock(recreateBaseClock(...), device)`.
 *
 * Determinism: D1. Both functions are pure.
 */
import type { VectorClock } from '../../src/sync-api'
import { incrementClock, recreateBaseClock } from '../../../sync-core/src/record-sync.ts'
import { meta } from './shared'

const A = 'device-a'
const B = 'device-b'
const OFF = '_offline'

interface RecreateClockSpec {
  name: string
  pins: string
  current: VectorClock | null
  tombstone: VectorClock | null
  operation: 'create' | 'update'
  device: string
}

const SPECS: RecreateClockSpec[] = [
  {
    name: 'create-without-tombstone',
    pins: 'no recorded tombstone: the clock is exactly the pre-#2409 fresh clock',
    current: null,
    tombstone: null,
    operation: 'create',
    device: A
  },
  {
    name: 'create-over-clocked-row-without-tombstone',
    pins: 'no recorded tombstone: an existing clock ticks exactly as before',
    current: { [A]: 3 },
    tombstone: null,
    operation: 'create',
    device: A
  },
  {
    name: 'create-after-own-delete',
    pins: 'the re-create ticks past this device’s own delete',
    current: null,
    tombstone: { [A]: 2 },
    operation: 'create',
    device: A
  },
  {
    name: 'create-after-remote-delete',
    pins: 'the re-create happens strictly after a peer’s delete',
    current: null,
    tombstone: { [A]: 1, [B]: 2 },
    operation: 'create',
    device: A
  },
  {
    name: 'create-over-first-clock-merges-tombstone',
    pins: 'a row minted with a first clock (calendar mirror) still absorbs the tombstone on create',
    current: { [A]: 1 },
    tombstone: { [B]: 2 },
    operation: 'create',
    device: A
  },
  {
    name: 'create-already-past-tombstone',
    pins: 'a local clock that already dominates the tombstone is unchanged by the merge',
    current: { [A]: 3 },
    tombstone: { [A]: 1 },
    operation: 'create',
    device: A
  },
  {
    name: 'update-of-clockless-row-merges-tombstone',
    pins: 'a first write to a clockless row is a re-create even when sent as update (property_definition)',
    current: null,
    tombstone: { [B]: 2 },
    operation: 'update',
    device: A
  },
  {
    name: 'update-of-empty-clock-merges-tombstone',
    pins: 'an empty clock is clockless',
    current: {},
    tombstone: { [B]: 2 },
    operation: 'update',
    device: A
  },
  {
    name: 'update-of-clocked-row-ignores-tombstone',
    pins: 'a row that survived a delete never absorbs it: delete-wins stays intact (§5.8)',
    current: { [A]: 3 },
    tombstone: { [B]: 5 },
    operation: 'update',
    device: A
  },
  {
    name: 'offline-key-in-tombstone-is-kept',
    pins: '§6.1: `_offline` is an ordinary key; dropping it would let the tombstone dominate',
    current: null,
    tombstone: { [A]: 1, [OFF]: 2 },
    operation: 'create',
    device: A
  },
  {
    name: 'empty-tombstone-is-no-tombstone',
    pins: 'an empty tombstone clock merges nothing',
    current: null,
    tombstone: {},
    operation: 'create',
    device: A
  }
]

export function buildRecreateClock(): Record<string, unknown> {
  const cases = SPECS.map((spec) => {
    const base = recreateBaseClock(spec.current, spec.tombstone, spec.operation)
    return {
      ...spec,
      expected: { base, next: incrementClock(base, spec.device) }
    }
  })

  return {
    meta: meta({
      class: 'recreate-clock',
      chapter: 'docs/protocol/06-vector-clocks-and-field-merge.md',
      implementation: 'packages/sync-core/src/record-sync.ts',
      caseCount: cases.length
    }),
    cases
  }
}
