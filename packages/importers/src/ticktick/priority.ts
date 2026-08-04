import type { MemryPriority } from './types'
import { IMPORT_MESSAGE_CODES, type ImportMessage } from '../messages'

const TABLE: Record<number, MemryPriority> = { 0: 0, 1: 1, 3: 2, 5: 3 }

/** Map a TickTick priority (0 none, 1 low, 3 medium, 5 high) to Memry's 0-4 scale. */
export function mapPriority(ticktick: number): {
  priority: MemryPriority
  warning?: ImportMessage
} {
  const mapped = TABLE[ticktick]
  if (mapped === undefined) {
    return {
      priority: 0,
      warning: {
        code: IMPORT_MESSAGE_CODES.ticktickUnknownPriority,
        message: `Unknown TickTick priority ${ticktick} → none`,
        params: { priority: ticktick }
      }
    }
  }
  return { priority: mapped }
}
