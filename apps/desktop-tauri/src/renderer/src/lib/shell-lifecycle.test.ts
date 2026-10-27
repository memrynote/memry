import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { firstPaint, heartbeat } = vi.hoisted(() => ({
  firstPaint: vi.fn(() => Promise.resolve()),
  heartbeat: vi.fn(() => Promise.resolve())
}))
vi.mock('../../../generated/bindings', () => ({
  commands: { shellFirstPaint: firstPaint, shellHeartbeat: heartbeat }
}))

import { HEARTBEAT_INTERVAL_MS, startShellLifecycle } from './shell-lifecycle'

describe('startShellLifecycle', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
    vi.clearAllMocks()
  })

  it('reports the mount once, then beats every 2 s until stopped', async () => {
    const stop = startShellLifecycle()
    expect(firstPaint).toHaveBeenCalledTimes(1)
    expect(heartbeat).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(HEARTBEAT_INTERVAL_MS * 3)
    expect(heartbeat).toHaveBeenCalledTimes(4)
    expect(firstPaint).toHaveBeenCalledTimes(1)
    stop()
    await vi.advanceTimersByTimeAsync(HEARTBEAT_INTERVAL_MS * 2)
    expect(heartbeat).toHaveBeenCalledTimes(4)
  })
})
