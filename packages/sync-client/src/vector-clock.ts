import type { VectorClock } from '@memry/contracts/sync-api'

export type { VectorClock }

export type ClockComparison = 'equal' | 'before' | 'after' | 'concurrent'

export const createClock = (): VectorClock => ({})

export const increment = (clock: VectorClock, deviceId: string): VectorClock => ({
  ...clock,
  [deviceId]: (clock[deviceId] ?? 0) + 1
})

export const merge = (a: VectorClock, b: VectorClock): VectorClock => {
  const result: VectorClock = { ...a }
  for (const [device, tick] of Object.entries(b)) {
    result[device] = Math.max(result[device] ?? 0, tick)
  }
  return result
}

export const compare = (a: VectorClock, b: VectorClock): ClockComparison => {
  const allDevices = new Set([...Object.keys(a), ...Object.keys(b)])

  let aBeforeB = false
  let bBeforeA = false

  for (const device of allDevices) {
    const tickA = a[device] ?? 0
    const tickB = b[device] ?? 0

    if (tickA < tickB) aBeforeB = true
    if (tickA > tickB) bBeforeA = true

    if (aBeforeB && bBeforeA) return 'concurrent'
  }

  if (!aBeforeB && !bBeforeA) return 'equal'
  if (aBeforeB) return 'before'
  return 'after'
}

export const getTick = (clock: VectorClock, deviceId: string): number => clock[deviceId] ?? 0

/**
 * Reads a `clock` JSON column off a row the record-sync controller types as
 * `Record<string, unknown>` (or a schema column left untyped). The column only
 * ever holds a VectorClock or null, so this narrows the type and nothing else.
 */
// oxlint-disable-next-line typescript/no-unsafe-type-assertion -- JSON column written only by this app as VectorClock | null; the row type is erased to unknown, and validating would change behavior on persisted rows
export const clockFromColumn = (value: unknown): VectorClock | null => value as VectorClock | null
