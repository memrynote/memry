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
