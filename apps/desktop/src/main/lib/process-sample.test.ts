import { spawn } from 'child_process'
import { describe, expect, it } from 'vitest'
import { sampleProcess } from './process-sample'

const run = (code: string) => spawn(process.execPath, ['-e', code])

describe.skipIf(process.platform === 'win32')('sampleProcess', () => {
  it('tells a process that computes from one that sleeps, and reads nothing for one that is gone', async () => {
    const busy = run('const end = Date.now() + 10000; while (Date.now() < end) {}')
    const sleeping = run('setTimeout(() => {}, 10000)')
    try {
      await new Promise((resolve) => setTimeout(resolve, 1500))
      const [computing, idle] = await Promise.all([
        sampleProcess(busy.pid),
        sampleProcess(sleeping.pid)
      ])
      expect(computing?.runnable).toBe(true)
      expect(computing?.cpuSeconds).toBeGreaterThan(idle?.cpuSeconds ?? Infinity)
      expect(idle?.runnable).toBe(false)

      sleeping.kill()
      await new Promise((resolve) => sleeping.once('exit', resolve))
      await expect(sampleProcess(sleeping.pid)).resolves.toBeUndefined()
    } finally {
      busy.kill()
      sleeping.kill()
    }
  })
})
