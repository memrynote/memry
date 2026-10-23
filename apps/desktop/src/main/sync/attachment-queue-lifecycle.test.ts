import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

import { NetworkMonitor, type NetworkMonitorDeps } from './network'
import { NetworkError } from './http-client'
import { UploadQueue, type UploadFn } from './upload-queue'
import { registerAttachmentQueueReset, resetAttachmentQueue } from './attachment-outbox'

vi.mock('../lib/logger', () => ({
  createLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn()
  })
}))

vi.mock('../telemetry/diagnostics', () => ({
  trackMainLog: vi.fn()
}))

const inertDeps = (online: boolean): NetworkMonitorDeps => ({
  getIsOnline: () => online,
  onResume: () => {},
  onSuspend: () => {},
  offResume: () => {},
  offSuspend: () => {}
})

/** A real NetworkMonitor with no Electron behind it. */
const makeMonitor = (online = true): NetworkMonitor => new NetworkMonitor(0, inertDeps(online))

/** Drive a real 'status-changed' {online:true} emission. */
const emitNetworkRestored = (monitor: NetworkMonitor): void => {
  monitor.setOnlineForTests(false)
  monitor.setOnlineForTests(true)
}

const okUpload = (): UploadFn =>
  vi.fn(async (noteId: string) => ({
    attachmentId: `att-${noteId}`,
    sessionId: `sess-${noteId}`,
    manifest: {} as never
  }))

describe('attachment upload queue lifecycle', () => {
  afterEach(() => {
    registerAttachmentQueueReset(null)
    vi.useRealTimers()
  })

  // ==========================================================================
  // Why the singleton must not outlive its runtime
  // ==========================================================================

  describe('binding to the NetworkMonitor', () => {
    it('subscribes to the monitor it was constructed with and detaches on dispose', () => {
      const monitor = makeMonitor()

      const queue = new UploadQueue(okUpload(), monitor)
      expect(monitor.listenerCount('status-changed')).toBe(1)

      queue.dispose()
      expect(monitor.listenerCount('status-changed')).toBe(0)
    })

    // #given a runtime restart builds a brand-new NetworkMonitor
    it('a queue carried across a restart stays deaf to the CURRENT monitor', async () => {
      const dead = makeMonitor()
      const uploadFn = okUpload()
      const carriedOver = new UploadQueue(uploadFn, dead)
      const live = makeMonitor()

      // #when the live monitor reports the network came back
      emitNetworkRestored(live)
      await Promise.resolve()

      // #then nothing reaches the carried-over queue — this is the bug: its only
      // wake-up is wired to a monitor that is stopped and can never emit again.
      expect(live.listenerCount('status-changed')).toBe(0)
      expect(dead.listenerCount('status-changed')).toBe(1)

      carriedOver.dispose()
    })

    it('a disposed-and-rebuilt queue binds the current monitor and leaves the dead one clean', () => {
      const dead = makeMonitor()
      const first = new UploadQueue(okUpload(), dead)
      first.dispose()

      const live = makeMonitor()
      const second = new UploadQueue(okUpload(), live)

      expect(live.listenerCount('status-changed')).toBe(1)
      expect(dead.listenerCount('status-changed')).toBe(0)

      second.dispose()
    })

    it('does not accumulate listeners across repeated stop/start cycles', () => {
      const monitors: NetworkMonitor[] = []

      for (let i = 0; i < 12; i++) {
        const monitor = makeMonitor()
        monitors.push(monitor)
        const queue = new UploadQueue(okUpload(), monitor)
        expect(monitor.listenerCount('status-changed')).toBe(1)
        // What the runtime teardown now does on every cycle.
        queue.dispose()
      }

      // 12 cycles, zero survivors — a leak would show as a monitor still holding
      // its subscriber, and NetworkMonitor's ceiling is only 10.
      for (const monitor of monitors) {
        expect(monitor.listenerCount('status-changed')).toBe(0)
      }
    })
  })

  // ==========================================================================
  // The wake-up that is lost when the binding goes stale
  // ==========================================================================

  describe('network-restored wake-up', () => {
    beforeEach(() => {
      vi.useFakeTimers()
    })

    it('drains a queue sitting in network backoff without waiting out the delay', async () => {
      const monitor = makeMonitor()
      let attempts = 0
      const uploadFn: UploadFn = vi.fn(async (noteId: string) => {
        attempts++
        if (attempts === 1) throw new NetworkError('offline')
        return { attachmentId: `att-${noteId}`, sessionId: 'sess', manifest: {} as never }
      })
      const queue = new UploadQueue(uploadFn, monitor)

      const pending = queue.enqueue('note-1', '/tmp/a.pdf')
      await vi.advanceTimersByTimeAsync(0)
      // First attempt failed and the item went back on the queue behind a 1s
      // network backoff.
      expect(uploadFn).toHaveBeenCalledTimes(1)

      // #when the network comes back
      emitNetworkRestored(monitor)
      await vi.advanceTimersByTimeAsync(0)

      // #then it retried immediately — no timer advance was needed to get here.
      expect(uploadFn).toHaveBeenCalledTimes(2)
      await expect(pending).resolves.toMatchObject({ attachmentId: 'att-note-1' })

      queue.dispose()
    })

    it('a restored event on a different monitor does not wake the queue', async () => {
      const bound = makeMonitor()
      let attempts = 0
      const uploadFn: UploadFn = vi.fn(async (noteId: string) => {
        attempts++
        if (attempts === 1) throw new NetworkError('offline')
        return { attachmentId: `att-${noteId}`, sessionId: 'sess', manifest: {} as never }
      })
      const queue = new UploadQueue(uploadFn, bound)

      const pending = queue.enqueue('note-1', '/tmp/a.pdf')
      await vi.advanceTimersByTimeAsync(0)
      expect(uploadFn).toHaveBeenCalledTimes(1)

      // #when the RESTART's monitor reports the network is back
      const live = makeMonitor()
      emitNetworkRestored(live)
      await vi.advanceTimersByTimeAsync(0)

      // #then the queue is unmoved — it only resumes once its own backoff timer
      // expires, which is the session-long stall this fix exists to prevent.
      expect(uploadFn).toHaveBeenCalledTimes(1)

      await vi.advanceTimersByTimeAsync(1000)
      expect(uploadFn).toHaveBeenCalledTimes(2)
      await expect(pending).resolves.toMatchObject({ attachmentId: 'att-note-1' })

      queue.dispose()
    })
  })

  // ==========================================================================
  // The seam the sync runtime uses to enforce all of the above
  // ==========================================================================

  describe('reset registry', () => {
    it('no-ops when no disposer is registered', () => {
      expect(() => resetAttachmentQueue()).not.toThrow()
    })

    it('invokes the registered disposer', () => {
      const dispose = vi.fn()
      registerAttachmentQueueReset(dispose)

      resetAttachmentQueue()

      expect(dispose).toHaveBeenCalledTimes(1)
    })

    it('stops invoking the disposer once deregistered', () => {
      const dispose = vi.fn()
      registerAttachmentQueueReset(dispose)
      resetAttachmentQueue()

      registerAttachmentQueueReset(null)
      resetAttachmentQueue()

      expect(dispose).toHaveBeenCalledTimes(1)
    })

    it('really does tear the queue off its monitor when wired to a queue holder', () => {
      // The production shape: a module-level slot the IPC layer owns and the
      // runtime resets.
      const monitor = makeMonitor()
      let queue: UploadQueue | null = new UploadQueue(okUpload(), monitor)
      registerAttachmentQueueReset(() => {
        queue?.dispose()
        queue = null
      })
      expect(monitor.listenerCount('status-changed')).toBe(1)

      resetAttachmentQueue()

      expect(queue).toBeNull()
      expect(monitor.listenerCount('status-changed')).toBe(0)
    })
  })
})
