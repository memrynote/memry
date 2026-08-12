import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import {
  NetworkMonitor,
  NetworkMonitorDeps,
  OFFLINE_POLL_INTERVAL_MS,
  ONLINE_POLL_INTERVAL_MS
} from './network'

interface MockDeps extends NetworkMonitorDeps {
  triggerResume: () => void
  triggerSuspend: () => void
  setOnline: (v: boolean) => void
}

function createMockDeps(initialOnline = true): MockDeps {
  let online = initialOnline
  const resumeCallbacks: Array<() => void> = []
  const suspendCallbacks: Array<() => void> = []
  return {
    getIsOnline: () => online,
    onResume: (cb) => resumeCallbacks.push(cb),
    onSuspend: (cb) => suspendCallbacks.push(cb),
    offResume: (cb) => {
      const i = resumeCallbacks.indexOf(cb)
      if (i >= 0) resumeCallbacks.splice(i, 1)
    },
    offSuspend: (cb) => {
      const i = suspendCallbacks.indexOf(cb)
      if (i >= 0) suspendCallbacks.splice(i, 1)
    },
    triggerResume: () => resumeCallbacks.forEach((cb) => cb()),
    triggerSuspend: () => suspendCallbacks.forEach((cb) => cb()),
    setOnline: (v: boolean) => {
      online = v
    }
  }
}

describe('NetworkMonitor', () => {
  let monitor: NetworkMonitor
  let deps: MockDeps

  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    monitor?.stop()
    vi.useRealTimers()
  })

  describe('#given online initially', () => {
    beforeEach(() => {
      deps = createMockDeps(true)
      monitor = new NetworkMonitor(200, deps)
    })

    it('#when constructed #then online property is true', () => {
      expect(monitor.online).toBe(true)
    })

    it('#when network goes offline #then emits status-changed after debounce', () => {
      const handler = vi.fn()
      monitor.on('status-changed', handler)
      monitor.start()

      deps.setOnline(false)
      vi.advanceTimersByTime(ONLINE_POLL_INTERVAL_MS)

      expect(handler).not.toHaveBeenCalled()
      expect(monitor.online).toBe(true)

      vi.advanceTimersByTime(200)

      expect(handler).toHaveBeenCalledOnce()
      expect(handler).toHaveBeenCalledWith({ online: false })
      expect(monitor.online).toBe(false)
    })

    it('#when suspend event fires #then sets offline immediately', () => {
      const handler = vi.fn()
      monitor.on('status-changed', handler)
      monitor.start()

      deps.triggerSuspend()

      expect(handler).toHaveBeenCalledOnce()
      expect(handler).toHaveBeenCalledWith({ online: false })
      expect(monitor.online).toBe(false)
    })

    it('#when stop called #then clears all timers and removes listeners', () => {
      const handler = vi.fn()
      monitor.on('status-changed', handler)
      monitor.start()

      deps.setOnline(false)
      vi.advanceTimersByTime(ONLINE_POLL_INTERVAL_MS)

      monitor.stop()

      vi.advanceTimersByTime(200)
      expect(handler).not.toHaveBeenCalled()

      vi.advanceTimersByTime(10000)
      expect(handler).not.toHaveBeenCalled()

      deps.triggerResume()
      deps.triggerSuspend()
      expect(handler).not.toHaveBeenCalled()
    })
  })

  describe('#given offline initially', () => {
    beforeEach(() => {
      deps = createMockDeps(false)
      monitor = new NetworkMonitor(200, deps)
    })

    it('#when constructed #then online property is false', () => {
      expect(monitor.online).toBe(false)
    })

    it('#when network comes back #then emits status-changed after debounce', () => {
      const handler = vi.fn()
      monitor.on('status-changed', handler)
      monitor.start()

      deps.setOnline(true)
      vi.advanceTimersByTime(OFFLINE_POLL_INTERVAL_MS)

      expect(handler).not.toHaveBeenCalled()

      vi.advanceTimersByTime(200)

      expect(handler).toHaveBeenCalledOnce()
      expect(handler).toHaveBeenCalledWith({ online: true })
      expect(monitor.online).toBe(true)
    })

    it('#when resume event fires and online #then emits status-changed after debounce', () => {
      const handler = vi.fn()
      monitor.on('status-changed', handler)
      monitor.start()

      deps.setOnline(true)
      deps.triggerResume()

      expect(handler).not.toHaveBeenCalled()

      vi.advanceTimersByTime(200)

      expect(handler).toHaveBeenCalledOnce()
      expect(handler).toHaveBeenCalledWith({ online: true })
    })

    it('#when resume event fires but still offline #then does not emit', () => {
      const handler = vi.fn()
      monitor.on('status-changed', handler)
      monitor.start()

      deps.triggerResume()

      vi.advanceTimersByTime(200)
      expect(handler).not.toHaveBeenCalled()
    })
  })

  describe('#given rapid online/offline flips', () => {
    beforeEach(() => {
      deps = createMockDeps(true)
      monitor = new NetworkMonitor(200, deps)
    })

    it('#when flipping back within debounce window #then cancels pending change', () => {
      const handler = vi.fn()
      monitor.on('status-changed', handler)
      monitor.start()

      deps.setOnline(false)
      vi.advanceTimersByTime(ONLINE_POLL_INTERVAL_MS)

      deps.setOnline(true)
      deps.triggerResume()

      vi.advanceTimersByTime(5000)

      expect(handler).not.toHaveBeenCalled()
      expect(monitor.online).toBe(true)
    })

    it('#when settling on a different state #then emits once', () => {
      const handler = vi.fn()
      monitor.on('status-changed', handler)
      monitor.start()

      deps.setOnline(false)
      vi.advanceTimersByTime(ONLINE_POLL_INTERVAL_MS)

      deps.setOnline(true)
      vi.advanceTimersByTime(2000)

      deps.setOnline(false)
      vi.advanceTimersByTime(OFFLINE_POLL_INTERVAL_MS)

      vi.advanceTimersByTime(200)

      expect(handler).toHaveBeenCalledOnce()
      expect(handler).toHaveBeenCalledWith({ online: false })
    })
  })

  describe('#given the adaptive poll cadence', () => {
    it('#when online and idle #then does not wake at the offline cadence', () => {
      deps = createMockDeps(true)
      monitor = new NetworkMonitor(200, deps)
      const handler = vi.fn()
      monitor.on('status-changed', handler)
      monitor.start()

      deps.setOnline(false)
      // A full offline-cadence period plus the debounce: nothing has polled, so
      // the drop is not seen yet. This is the wakeup the app no longer pays
      // twelve times a minute while it just sits there connected.
      vi.advanceTimersByTime(OFFLINE_POLL_INTERVAL_MS + 200)
      expect(handler).not.toHaveBeenCalled()

      vi.advanceTimersByTime(ONLINE_POLL_INTERVAL_MS - OFFLINE_POLL_INTERVAL_MS + 200)
      expect(handler).toHaveBeenCalledOnce()
      expect(handler).toHaveBeenCalledWith({ online: false })
    })

    it('#when offline #then a returning network is still seen at the fast cadence', () => {
      deps = createMockDeps(false)
      monitor = new NetworkMonitor(200, deps)
      const handler = vi.fn()
      monitor.on('status-changed', handler)
      monitor.start()

      deps.setOnline(true)
      vi.advanceTimersByTime(OFFLINE_POLL_INTERVAL_MS + 200)

      expect(handler).toHaveBeenCalledOnce()
      expect(handler).toHaveBeenCalledWith({ online: true })
    })

    it('#when it drops offline while running #then it switches to the fast cadence at once', () => {
      // The reconnect guarantee: however long the slow cadence took to notice
      // the drop, the poll that sees the network return is 5s away, not 30s.
      deps = createMockDeps(true)
      monitor = new NetworkMonitor(200, deps)
      const handler = vi.fn()
      monitor.on('status-changed', handler)
      monitor.start()

      deps.setOnline(false)
      vi.advanceTimersByTime(ONLINE_POLL_INTERVAL_MS + 200)
      expect(handler).toHaveBeenCalledWith({ online: false })

      deps.setOnline(true)
      vi.advanceTimersByTime(OFFLINE_POLL_INTERVAL_MS + 200)

      expect(handler).toHaveBeenNthCalledWith(2, { online: true })
      expect(monitor.online).toBe(true)
    })

    it('#when suspended and resumed #then the wake is polled immediately', () => {
      deps = createMockDeps(true)
      monitor = new NetworkMonitor(200, deps)
      const handler = vi.fn()
      monitor.on('status-changed', handler)
      monitor.start()

      deps.triggerSuspend()
      expect(handler).toHaveBeenCalledWith({ online: false })

      // No timer advance at all: resume polls rather than waiting for a tick.
      deps.triggerResume()
      vi.advanceTimersByTime(200)

      expect(handler).toHaveBeenNthCalledWith(2, { online: true })
    })
  })

  describe('#given stopped monitor', () => {
    it('#when no poll interval #then does not emit', () => {
      deps = createMockDeps(true)
      monitor = new NetworkMonitor(200, deps)
      const handler = vi.fn()
      monitor.on('status-changed', handler)

      deps.setOnline(false)
      vi.advanceTimersByTime(10000)

      expect(handler).not.toHaveBeenCalled()
    })
  })

  describe('#given test-controlled network override', () => {
    beforeEach(() => {
      deps = createMockDeps(true)
      monitor = new NetworkMonitor(200, deps)
    })

    it('#when set offline for tests #then emits immediately and persists across polls', () => {
      const handler = vi.fn()
      monitor.on('status-changed', handler)
      monitor.start()

      monitor.setOnlineForTests(false)

      expect(handler).toHaveBeenCalledOnce()
      expect(handler).toHaveBeenCalledWith({ online: false })
      expect(monitor.online).toBe(false)

      deps.setOnline(true)
      vi.advanceTimersByTime(20000)

      expect(monitor.online).toBe(false)
      expect(handler).toHaveBeenCalledOnce()
    })

    it('#when restored online for tests #then emits immediately', () => {
      const handler = vi.fn()
      monitor.on('status-changed', handler)
      monitor.start()

      monitor.setOnlineForTests(false)
      monitor.setOnlineForTests(true)

      expect(handler).toHaveBeenNthCalledWith(1, { online: false })
      expect(handler).toHaveBeenNthCalledWith(2, { online: true })
      expect(monitor.online).toBe(true)
    })
  })
})
