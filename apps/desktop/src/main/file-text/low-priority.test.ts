import { spawn } from 'child_process'
import os from 'os'
import { describe, expect, it } from 'vitest'
import { lowerProcessPriority } from './low-priority'

describe('lowerProcessPriority', () => {
  it('drops a running process to the lowest priority, and ignores one that is gone', async () => {
    const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 10000)'])
    try {
      lowerProcessPriority(child.pid)
      expect(os.getPriority(child.pid)).toBe(os.constants.priority.PRIORITY_LOW)

      child.kill()
      await new Promise((resolve) => child.once('exit', resolve))
      expect(() => lowerProcessPriority(child.pid)).not.toThrow()
    } finally {
      child.kill()
    }
  })
})
