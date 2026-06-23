import type { MemryPriority } from './types'

const TABLE: Record<number, MemryPriority> = { 0: 0, 1: 1, 3: 2, 5: 3 }

/** Map a TickTick priority (0 none, 1 low, 3 medium, 5 high) to Memry's 0-4 scale. */
export function mapPriority(ticktick: number): { priority: MemryPriority; warning?: string } {
  const mapped = TABLE[ticktick]
  if (mapped === undefined) {
    return { priority: 0, warning: `Unknown TickTick priority ${ticktick} → none` }
  }
  return { priority: mapped }
}
