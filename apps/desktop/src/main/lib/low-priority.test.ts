import { execFileSync, spawn } from 'child_process'
import os from 'os'
import { describe, expect, it } from 'vitest'
import { lowerProcessPriority, moveToBackground } from './low-priority'

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

describe('moveToBackground', () => {
  // Darwin background QoS shows as scheduling priority 4 in ps.
  it.runIf(process.platform === 'darwin')(
    'puts a running process in background QoS, and ignores one that is gone',
    async () => {
      const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 10000)'])
      const pid = child.pid
      const scheduling = (): number =>
        Number(
          execFileSync('ps', ['-o', 'pri=', '-p', String(pid)])
            .toString()
            .trim()
        )
      try {
        expect(scheduling()).toBeGreaterThan(4)
        await moveToBackground(pid)
        expect(scheduling()).toBe(4)
        expect(os.getPriority(pid)).toBe(os.constants.priority.PRIORITY_LOW)

        child.kill()
        await new Promise((resolve) => child.once('exit', resolve))
        await expect(moveToBackground(pid)).resolves.toBeUndefined()
      } finally {
        child.kill()
      }
    }
  )
})
