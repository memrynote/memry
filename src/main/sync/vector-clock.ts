/**
 * Vector Clock Implementation
 *
 * Provides Lamport-style vector clocks for tracking causality in distributed
 * sync operations. Vector clocks enable:
 * - Detecting concurrent modifications
 * - Establishing happened-before relationships
 * - Conflict detection and resolution
 *
 * @module main/sync/vector-clock
 */

import type { VectorClock } from '@shared/contracts/sync-api'

// =============================================================================
// Types
// =============================================================================

/**
 * Comparison result for two vector clocks.
 *
 * - `BEFORE`: Clock A happened before Clock B
 * - `AFTER`: Clock A happened after Clock B
 * - `CONCURRENT`: Clocks are concurrent (conflict)
 * - `EQUAL`: Clocks are identical
 */
export enum ClockComparison {
  BEFORE = -1,
  AFTER = 1,
  CONCURRENT = 0,
  EQUAL = 2
}

// =============================================================================
// Basic Operations
// =============================================================================

/**
 * Create a new empty vector clock.
 *
 * @returns Empty vector clock
 */
export function createClock(): VectorClock {
  return {}
}

/**
 * Increment the clock for a specific device.
 *
 * Call this when a local operation occurs (create, update, delete).
 *
 * @param clock - Current vector clock
 * @param deviceId - Device ID that performed the operation
 * @returns New vector clock with incremented device time
 *
 * @example
 * ```typescript
 * let clock = createClock()
 * clock = incrementClock(clock, 'device-1')
 * // { 'device-1': 1 }
 * clock = incrementClock(clock, 'device-1')
 * // { 'device-1': 2 }
 * ```
 */
export function incrementClock(clock: VectorClock, deviceId: string): VectorClock {
  return {
    ...clock,
    [deviceId]: (clock[deviceId] ?? 0) + 1
  }
}

/**
 * Get the time for a specific device in the clock.
 *
 * @param clock - Vector clock
 * @param deviceId - Device ID
 * @returns Time value for the device (0 if not present)
 */
export function getTime(clock: VectorClock, deviceId: string): number {
  return clock[deviceId] ?? 0
}

/**
 * Get all device IDs present in a clock.
 *
 * @param clock - Vector clock
 * @returns Array of device IDs
 */
export function getDevices(clock: VectorClock): string[] {
  return Object.keys(clock)
}

// =============================================================================
// Merge Operations
// =============================================================================

/**
 * Merge two vector clocks, taking the maximum time for each device.
 *
 * Use this when receiving updates from another device to update
 * the local understanding of global time.
 *
 * @param a - First vector clock
 * @param b - Second vector clock
 * @returns Merged clock with max times
 *
 * @example
 * ```typescript
 * const local = { 'device-1': 3, 'device-2': 2 }
 * const remote = { 'device-1': 2, 'device-2': 4, 'device-3': 1 }
 * const merged = mergeClock(local, remote)
 * // { 'device-1': 3, 'device-2': 4, 'device-3': 1 }
 * ```
 */
export function mergeClock(a: VectorClock, b: VectorClock): VectorClock {
  const merged: VectorClock = { ...a }

  for (const [device, time] of Object.entries(b)) {
    merged[device] = Math.max(merged[device] ?? 0, time)
  }

  return merged
}

/**
 * Update a clock after receiving a remote operation.
 *
 * This merges the remote clock and then increments for the local device.
 *
 * @param localClock - Local vector clock
 * @param remoteClock - Remote vector clock from received operation
 * @param localDeviceId - Local device ID
 * @returns Updated clock
 */
export function updateClockFromRemote(
  localClock: VectorClock,
  remoteClock: VectorClock,
  localDeviceId: string
): VectorClock {
  const merged = mergeClock(localClock, remoteClock)
  return incrementClock(merged, localDeviceId)
}

// =============================================================================
// Comparison Operations
// =============================================================================

/**
 * Compare two vector clocks to determine their causal relationship.
 *
 * @param a - First vector clock
 * @param b - Second vector clock
 * @returns Comparison result
 *
 * @example
 * ```typescript
 * const a = { 'device-1': 2, 'device-2': 1 }
 * const b = { 'device-1': 2, 'device-2': 2 }
 * compareClock(a, b) // BEFORE (a happened before b)
 *
 * const c = { 'device-1': 3, 'device-2': 1 }
 * compareClock(c, b) // CONCURRENT (neither happened before the other)
 * ```
 */
export function compareClock(a: VectorClock, b: VectorClock): ClockComparison {
  // Get all unique device IDs
  const allDevices = new Set([...Object.keys(a), ...Object.keys(b)])

  let aLessOrEqual = true
  let bLessOrEqual = true

  for (const device of allDevices) {
    const timeA = a[device] ?? 0
    const timeB = b[device] ?? 0

    if (timeA > timeB) {
      // A has higher value at this device, so A is NOT <= B
      aLessOrEqual = false
    }
    if (timeB > timeA) {
      // B has higher value at this device, so B is NOT <= A
      bLessOrEqual = false
    }
  }

  if (aLessOrEqual && bLessOrEqual) {
    return ClockComparison.EQUAL
  }
  if (aLessOrEqual) {
    return ClockComparison.BEFORE
  }
  if (bLessOrEqual) {
    return ClockComparison.AFTER
  }

  return ClockComparison.CONCURRENT
}

/**
 * Check if clock A is an ancestor of clock B.
 *
 * A is an ancestor of B if A happened before B (all A's times are <= B's times,
 * and at least one is strictly less).
 *
 * @param ancestor - Potential ancestor clock
 * @param descendant - Potential descendant clock
 * @returns True if ancestor happened before descendant
 */
export function isAncestor(ancestor: VectorClock, descendant: VectorClock): boolean {
  const comparison = compareClock(ancestor, descendant)
  return comparison === ClockComparison.BEFORE
}

/**
 * Check if two clocks are concurrent (neither happened before the other).
 *
 * Concurrent operations indicate a potential conflict that needs resolution.
 *
 * @param a - First vector clock
 * @param b - Second vector clock
 * @returns True if clocks are concurrent
 */
export function isConcurrent(a: VectorClock, b: VectorClock): boolean {
  return compareClock(a, b) === ClockComparison.CONCURRENT
}

/**
 * Check if clock A dominates clock B (A >= B for all devices).
 *
 * @param a - First vector clock
 * @param b - Second vector clock
 * @returns True if A dominates B
 */
export function dominates(a: VectorClock, b: VectorClock): boolean {
  const comparison = compareClock(a, b)
  return comparison === ClockComparison.AFTER || comparison === ClockComparison.EQUAL
}

// =============================================================================
// Serialization
// =============================================================================

/**
 * Serialize a vector clock to a JSON string.
 *
 * @param clock - Vector clock
 * @returns JSON string representation
 */
export function serializeClock(clock: VectorClock): string {
  // Sort keys for deterministic serialization
  const sorted: VectorClock = {}
  const keys = Object.keys(clock).sort()

  for (const key of keys) {
    sorted[key] = clock[key]
  }

  return JSON.stringify(sorted)
}

/**
 * Deserialize a vector clock from a JSON string.
 *
 * @param json - JSON string representation
 * @returns Vector clock
 */
export function deserializeClock(json: string): VectorClock {
  try {
    const parsed = JSON.parse(json) as VectorClock

    // Validate the parsed object
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      return {}
    }

    // Validate all values are numbers
    const clock: VectorClock = {}
    for (const [key, value] of Object.entries(parsed)) {
      if (typeof value === 'number' && value >= 0 && Number.isInteger(value)) {
        clock[key] = value
      }
    }

    return clock
  } catch {
    return {}
  }
}

// =============================================================================
// Utility Operations
// =============================================================================

/**
 * Get the total sum of all times in the clock.
 *
 * Useful for rough ordering of events.
 *
 * @param clock - Vector clock
 * @returns Sum of all device times
 */
export function clockSum(clock: VectorClock): number {
  return Object.values(clock).reduce((sum, time) => sum + time, 0)
}

/**
 * Get the maximum time value in the clock.
 *
 * @param clock - Vector clock
 * @returns Maximum time value
 */
export function clockMax(clock: VectorClock): number {
  const times = Object.values(clock)
  return times.length > 0 ? Math.max(...times) : 0
}

/**
 * Check if a clock is empty (no device times recorded).
 *
 * @param clock - Vector clock
 * @returns True if clock has no entries
 */
export function isEmptyClock(clock: VectorClock): boolean {
  return Object.keys(clock).length === 0
}

/**
 * Create a copy of a vector clock.
 *
 * @param clock - Vector clock to copy
 * @returns New clock with same values
 */
export function copyClock(clock: VectorClock): VectorClock {
  return { ...clock }
}

/**
 * Remove a device from a clock.
 *
 * Use when a device is unlinked from the account.
 *
 * @param clock - Vector clock
 * @param deviceId - Device ID to remove
 * @returns New clock without the device
 */
export function removeDevice(clock: VectorClock, deviceId: string): VectorClock {
  const newClock = { ...clock }
  delete newClock[deviceId]
  return newClock
}
