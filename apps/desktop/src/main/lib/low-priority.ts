import os from 'os'
import { createLogger } from './logger'

const logger = createLogger('LowPriority')

/**
 * Background work (text extraction, local embeddings) yields the CPU to
 * everything else on the machine. Best effort, the work still runs without it.
 */
export function lowerProcessPriority(pid: number | undefined): void {
  if (!pid) return
  try {
    os.setPriority(pid, os.constants.priority.PRIORITY_LOW)
  } catch (error) {
    logger.debug('Could not lower process priority', { pid, error })
  }
}
