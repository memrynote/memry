/**
 * Vector Clock Tests
 *
 * Tests for the vector clock implementation used in distributed sync.
 *
 * @module main/sync/vector-clock.test
 */

import { describe, it, expect } from 'vitest'
import {
  createClock,
  incrementClock,
  getTime,
  getDevices,
  mergeClock,
  updateClockFromRemote,
  compareClock,
  ClockComparison,
  isAncestor,
  isConcurrent,
  dominates,
  serializeClock,
  deserializeClock,
  clockSum,
  clockMax,
  isEmptyClock,
  copyClock,
  removeDevice
} from './vector-clock'

describe('vector-clock', () => {
  // ===========================================================================
  // Basic Operations
  // ===========================================================================

  describe('createClock', () => {
    it('should create an empty clock', () => {
      const clock = createClock()
      expect(clock).toEqual({})
      expect(isEmptyClock(clock)).toBe(true)
    })
  })

  describe('incrementClock', () => {
    it('should increment a new device to 1', () => {
      const clock = createClock()
      const updated = incrementClock(clock, 'device-1')

      expect(updated).toEqual({ 'device-1': 1 })
    })

    it('should increment an existing device', () => {
      const clock = { 'device-1': 5 }
      const updated = incrementClock(clock, 'device-1')

      expect(updated).toEqual({ 'device-1': 6 })
    })

    it('should not mutate the original clock', () => {
      const clock = { 'device-1': 3 }
      const updated = incrementClock(clock, 'device-1')

      expect(clock).toEqual({ 'device-1': 3 })
      expect(updated).toEqual({ 'device-1': 4 })
    })

    it('should handle multiple devices', () => {
      let clock = createClock()
      clock = incrementClock(clock, 'device-1')
      clock = incrementClock(clock, 'device-2')
      clock = incrementClock(clock, 'device-1')

      expect(clock).toEqual({ 'device-1': 2, 'device-2': 1 })
    })
  })

  describe('getTime', () => {
    it('should return time for existing device', () => {
      const clock = { 'device-1': 5, 'device-2': 3 }

      expect(getTime(clock, 'device-1')).toBe(5)
      expect(getTime(clock, 'device-2')).toBe(3)
    })

    it('should return 0 for non-existent device', () => {
      const clock = { 'device-1': 5 }

      expect(getTime(clock, 'device-2')).toBe(0)
    })
  })

  describe('getDevices', () => {
    it('should return all device IDs', () => {
      const clock = { 'device-1': 5, 'device-2': 3, 'device-3': 1 }
      const devices = getDevices(clock)

      expect(devices).toHaveLength(3)
      expect(devices).toContain('device-1')
      expect(devices).toContain('device-2')
      expect(devices).toContain('device-3')
    })

    it('should return empty array for empty clock', () => {
      const clock = createClock()
      expect(getDevices(clock)).toEqual([])
    })
  })

  // ===========================================================================
  // Merge Operations
  // ===========================================================================

  describe('mergeClock', () => {
    it('should merge two clocks taking max values', () => {
      const a = { 'device-1': 3, 'device-2': 2 }
      const b = { 'device-1': 2, 'device-2': 4 }

      const merged = mergeClock(a, b)

      expect(merged).toEqual({ 'device-1': 3, 'device-2': 4 })
    })

    it('should include devices from both clocks', () => {
      const a = { 'device-1': 3 }
      const b = { 'device-2': 4 }

      const merged = mergeClock(a, b)

      expect(merged).toEqual({ 'device-1': 3, 'device-2': 4 })
    })

    it('should handle empty clocks', () => {
      const empty = createClock()
      const clock = { 'device-1': 5 }

      expect(mergeClock(empty, clock)).toEqual({ 'device-1': 5 })
      expect(mergeClock(clock, empty)).toEqual({ 'device-1': 5 })
      expect(mergeClock(empty, empty)).toEqual({})
    })

    it('should not mutate original clocks', () => {
      const a = { 'device-1': 3 }
      const b = { 'device-1': 5 }

      mergeClock(a, b)

      expect(a).toEqual({ 'device-1': 3 })
      expect(b).toEqual({ 'device-1': 5 })
    })
  })

  describe('updateClockFromRemote', () => {
    it('should merge remote clock and increment local', () => {
      const local = { 'device-A': 2 }
      const remote = { 'device-B': 3 }

      const updated = updateClockFromRemote(local, remote, 'device-A')

      expect(updated).toEqual({ 'device-A': 3, 'device-B': 3 })
    })

    it('should handle overlapping device entries', () => {
      const local = { 'device-A': 2, 'device-B': 1 }
      const remote = { 'device-A': 1, 'device-B': 5 }

      const updated = updateClockFromRemote(local, remote, 'device-A')

      // Merge takes max: { A: 2, B: 5 }, then increment A: { A: 3, B: 5 }
      expect(updated).toEqual({ 'device-A': 3, 'device-B': 5 })
    })
  })

  // ===========================================================================
  // Comparison Operations
  // ===========================================================================

  describe('compareClock', () => {
    it('should return EQUAL for identical clocks', () => {
      const a = { 'device-1': 3, 'device-2': 2 }
      const b = { 'device-1': 3, 'device-2': 2 }

      expect(compareClock(a, b)).toBe(ClockComparison.EQUAL)
    })

    it('should return EQUAL for empty clocks', () => {
      expect(compareClock({}, {})).toBe(ClockComparison.EQUAL)
    })

    it('should return BEFORE when A happened before B', () => {
      const a = { 'device-1': 2 }
      const b = { 'device-1': 3 }

      expect(compareClock(a, b)).toBe(ClockComparison.BEFORE)
    })

    it('should return BEFORE when A is subset of B', () => {
      const a = { 'device-1': 2 }
      const b = { 'device-1': 2, 'device-2': 1 }

      expect(compareClock(a, b)).toBe(ClockComparison.BEFORE)
    })

    it('should return AFTER when A happened after B', () => {
      const a = { 'device-1': 5 }
      const b = { 'device-1': 3 }

      expect(compareClock(a, b)).toBe(ClockComparison.AFTER)
    })

    it('should return CONCURRENT for concurrent clocks', () => {
      // Device 1 is ahead on A, Device 2 is ahead on B
      const a = { 'device-1': 3, 'device-2': 1 }
      const b = { 'device-1': 2, 'device-2': 4 }

      expect(compareClock(a, b)).toBe(ClockComparison.CONCURRENT)
    })

    it('should return CONCURRENT for divergent clocks', () => {
      const a = { 'device-1': 5 }
      const b = { 'device-2': 3 }

      // Neither can be ordered - they're from different devices with no shared history
      expect(compareClock(a, b)).toBe(ClockComparison.CONCURRENT)
    })
  })

  describe('isAncestor', () => {
    it('should return true when first clock happened before second', () => {
      const ancestor = { 'device-1': 1 }
      const descendant = { 'device-1': 3 }

      expect(isAncestor(ancestor, descendant)).toBe(true)
    })

    it('should return false for equal clocks', () => {
      const a = { 'device-1': 3 }
      const b = { 'device-1': 3 }

      expect(isAncestor(a, b)).toBe(false)
    })

    it('should return false for concurrent clocks', () => {
      const a = { 'device-1': 3 }
      const b = { 'device-2': 3 }

      expect(isAncestor(a, b)).toBe(false)
    })
  })

  describe('isConcurrent', () => {
    it('should return true for concurrent clocks', () => {
      const a = { 'device-1': 3, 'device-2': 1 }
      const b = { 'device-1': 2, 'device-2': 4 }

      expect(isConcurrent(a, b)).toBe(true)
    })

    it('should return false for ordered clocks', () => {
      const a = { 'device-1': 1 }
      const b = { 'device-1': 3 }

      expect(isConcurrent(a, b)).toBe(false)
    })

    it('should return false for equal clocks', () => {
      const a = { 'device-1': 3 }
      const b = { 'device-1': 3 }

      expect(isConcurrent(a, b)).toBe(false)
    })
  })

  describe('dominates', () => {
    it('should return true when A >= B for all devices', () => {
      const a = { 'device-1': 5, 'device-2': 3 }
      const b = { 'device-1': 3, 'device-2': 2 }

      expect(dominates(a, b)).toBe(true)
    })

    it('should return true for equal clocks', () => {
      const a = { 'device-1': 3 }
      const b = { 'device-1': 3 }

      expect(dominates(a, b)).toBe(true)
    })

    it('should return false for concurrent clocks', () => {
      const a = { 'device-1': 3, 'device-2': 1 }
      const b = { 'device-1': 2, 'device-2': 4 }

      expect(dominates(a, b)).toBe(false)
    })
  })

  // ===========================================================================
  // Serialization
  // ===========================================================================

  describe('serializeClock', () => {
    it('should serialize clock to JSON', () => {
      const clock = { 'device-1': 3, 'device-2': 5 }
      const json = serializeClock(clock)

      expect(JSON.parse(json)).toEqual(clock)
    })

    it('should produce deterministic output (sorted keys)', () => {
      const clock1 = { 'device-b': 2, 'device-a': 1 }
      const clock2 = { 'device-a': 1, 'device-b': 2 }

      expect(serializeClock(clock1)).toBe(serializeClock(clock2))
    })

    it('should handle empty clock', () => {
      expect(serializeClock({})).toBe('{}')
    })
  })

  describe('deserializeClock', () => {
    it('should deserialize valid JSON', () => {
      const json = '{"device-1":3,"device-2":5}'
      const clock = deserializeClock(json)

      expect(clock).toEqual({ 'device-1': 3, 'device-2': 5 })
    })

    it('should return empty clock for invalid JSON', () => {
      expect(deserializeClock('not json')).toEqual({})
      expect(deserializeClock('')).toEqual({})
    })

    it('should filter out non-integer values', () => {
      const json = '{"device-1":3,"device-2":"invalid","device-3":-1}'
      const clock = deserializeClock(json)

      expect(clock).toEqual({ 'device-1': 3 })
    })

    it('should handle null/array JSON', () => {
      expect(deserializeClock('null')).toEqual({})
      expect(deserializeClock('[1,2,3]')).toEqual({})
    })
  })

  describe('round-trip serialization', () => {
    it('should preserve clock through serialize/deserialize', () => {
      const original = { 'device-1': 5, 'device-2': 3, 'device-3': 7 }
      const json = serializeClock(original)
      const restored = deserializeClock(json)

      expect(restored).toEqual(original)
    })
  })

  // ===========================================================================
  // Utility Operations
  // ===========================================================================

  describe('clockSum', () => {
    it('should return sum of all times', () => {
      const clock = { 'device-1': 3, 'device-2': 5, 'device-3': 2 }
      expect(clockSum(clock)).toBe(10)
    })

    it('should return 0 for empty clock', () => {
      expect(clockSum({})).toBe(0)
    })
  })

  describe('clockMax', () => {
    it('should return maximum time value', () => {
      const clock = { 'device-1': 3, 'device-2': 5, 'device-3': 2 }
      expect(clockMax(clock)).toBe(5)
    })

    it('should return 0 for empty clock', () => {
      expect(clockMax({})).toBe(0)
    })
  })

  describe('isEmptyClock', () => {
    it('should return true for empty clock', () => {
      expect(isEmptyClock({})).toBe(true)
      expect(isEmptyClock(createClock())).toBe(true)
    })

    it('should return false for non-empty clock', () => {
      expect(isEmptyClock({ 'device-1': 1 })).toBe(false)
    })
  })

  describe('copyClock', () => {
    it('should create a shallow copy', () => {
      const original = { 'device-1': 3, 'device-2': 5 }
      const copy = copyClock(original)

      expect(copy).toEqual(original)
      expect(copy).not.toBe(original)
    })

    it('should allow independent modification', () => {
      const original = { 'device-1': 3 }
      const copy = copyClock(original)

      copy['device-1'] = 10

      expect(original['device-1']).toBe(3)
      expect(copy['device-1']).toBe(10)
    })
  })

  describe('removeDevice', () => {
    it('should remove a device from the clock', () => {
      const clock = { 'device-1': 3, 'device-2': 5 }
      const updated = removeDevice(clock, 'device-1')

      expect(updated).toEqual({ 'device-2': 5 })
    })

    it('should not mutate original clock', () => {
      const clock = { 'device-1': 3, 'device-2': 5 }
      removeDevice(clock, 'device-1')

      expect(clock).toEqual({ 'device-1': 3, 'device-2': 5 })
    })

    it('should handle removing non-existent device', () => {
      const clock = { 'device-1': 3 }
      const updated = removeDevice(clock, 'device-2')

      expect(updated).toEqual({ 'device-1': 3 })
    })
  })

  // ===========================================================================
  // Real-World Sync Scenarios
  // ===========================================================================

  describe('sync scenarios', () => {
    it('should detect conflict when two devices edit concurrently', () => {
      // Initial state on both devices
      const initial = { 'device-A': 1 }

      // Device A makes an edit
      const deviceAClock = incrementClock(initial, 'device-A')
      // { 'device-A': 2 }

      // Device B makes an edit (doesn't know about A's edit yet)
      const deviceBClock = incrementClock(initial, 'device-B')
      // { 'device-A': 1, 'device-B': 1 }

      // When they sync, detect conflict
      expect(isConcurrent(deviceAClock, deviceBClock)).toBe(true)
    })

    it('should recognize ordered updates after sync', () => {
      // Device A makes changes
      let deviceA = incrementClock({}, 'device-A')
      deviceA = incrementClock(deviceA, 'device-A')
      // { 'device-A': 2 }

      // Device B syncs and gets A's clock
      let deviceB = mergeClock({}, deviceA)
      // { 'device-A': 2 }

      // Device B makes a change
      deviceB = incrementClock(deviceB, 'device-B')
      // { 'device-A': 2, 'device-B': 1 }

      // B's clock now happened after A's
      expect(compareClock(deviceA, deviceB)).toBe(ClockComparison.BEFORE)
      expect(isAncestor(deviceA, deviceB)).toBe(true)
    })

    it('should simulate multi-device sync chain', () => {
      // Device A creates item
      let clockA = incrementClock({}, 'device-A')
      // { A: 1 }

      // Device B syncs from A, then edits
      let clockB = mergeClock({}, clockA)
      clockB = incrementClock(clockB, 'device-B')
      // { A: 1, B: 1 }

      // Device C syncs from B, then edits
      let clockC = mergeClock({}, clockB)
      clockC = incrementClock(clockC, 'device-C')
      // { A: 1, B: 1, C: 1 }

      // All clocks are ordered (A → B → C)
      expect(isAncestor(clockA, clockB)).toBe(true)
      expect(isAncestor(clockB, clockC)).toBe(true)
      expect(isAncestor(clockA, clockC)).toBe(true)
    })
  })
})
