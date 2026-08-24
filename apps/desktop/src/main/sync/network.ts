import { SyncEventEmitter } from '@memry/sync-client/emitter'

export interface NetworkMonitorDeps {
  getIsOnline: () => boolean
  onResume: (cb: () => void) => void
  onSuspend: (cb: () => void) => void
  offResume: (cb: () => void) => void
  offSuspend: (cb: () => void) => void
}

function createElectronDeps(): NetworkMonitorDeps {
  // eslint-disable-next-line @typescript-eslint/no-require-imports -- lazy import avoids Electron in tests
  const electron = require('electron') as typeof import('electron')
  return {
    getIsOnline: () => electron.net.online,
    onResume: (cb) => electron.powerMonitor.on('resume', cb),
    onSuspend: (cb) => electron.powerMonitor.on('suspend', cb),
    offResume: (cb) => electron.powerMonitor.removeListener('resume', cb),
    offSuspend: (cb) => electron.powerMonitor.removeListener('suspend', cb)
  }
}

// Electron exposes no main-process event for `net.online` — only powerMonitor
// resume/suspend, which are already wired below — so the status has to be
// polled. The read itself is a cheap in-process property; the cost is purely
// the timer wakeup, and a wakeup every 5s for the lifetime of the app is what
// keeps the main process out of deep idle / App Nap on an otherwise idle
// machine.
//
// The two directions are not worth the same, so they do not poll at the same
// rate:
//
// - Offline -> online is latency-critical. It is what re-arms the WebSocket,
//   the periodic pull and the CRDT queue, so a returning network must be seen
//   fast. It stays at 5s, and powerMonitor 'resume' additionally polls at once,
//   so a machine waking with the network back is picked up immediately rather
//   than at the next tick.
// - Online -> offline is not. A lost network is already surfaced by the request
//   that fails and by the WebSocket heartbeat (25s ping / 31s terminate); all
//   this transition adds is the offline status and the eager teardown. Seeing
//   it up to 30s later costs nothing the retry paths do not already cover.
//
// Because 'suspend' applies offline immediately, a suspended machine is on the
// 5s cadence before it sleeps — the slow cadence never applies to a wake.
export const OFFLINE_POLL_INTERVAL_MS = 5000
export const ONLINE_POLL_INTERVAL_MS = 30_000
const DEFAULT_DEBOUNCE_MS = 2000
// 'status-changed' is the only event, and it has three steady-state
// subscribers: the SyncEngine (attached in start(), removed in stop()), the
// sync runtime, and the attachment UploadQueue. Keeping the ceiling at Node's
// default leaves headroom without hiding an accumulating subscriber behind a
// silent budget. See src/main/sync/emitter-budget.test.ts.
const MAX_NETWORK_MONITOR_LISTENERS = 10

export class NetworkMonitor extends SyncEventEmitter {
  private _online: boolean
  private onlineOverrideForTests: boolean | null = null
  private pollTimer: ReturnType<typeof setTimeout> | null = null
  private polling = false
  private debounceTimer: ReturnType<typeof setTimeout> | null = null
  private readonly deps: NetworkMonitorDeps
  private readonly debounceMs: number
  private resumeHandler: (() => void) | null = null
  private suspendHandler: (() => void) | null = null

  constructor(debounceMs?: number, deps?: NetworkMonitorDeps) {
    super()
    this.setMaxListeners(MAX_NETWORK_MONITOR_LISTENERS)
    this.deps = deps ?? createElectronDeps()
    this.debounceMs = debounceMs ?? DEFAULT_DEBOUNCE_MS
    this._online = this.deps.getIsOnline()
  }

  get online(): boolean {
    return this.onlineOverrideForTests ?? this._online
  }

  setOnlineForTests(online: boolean | null): void {
    this.onlineOverrideForTests = online
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer)
      this.debounceTimer = null
    }
    this.applyStatus(this.resolveOnlineStatus())
  }

  start(): void {
    this.polling = true
    this.schedulePoll()

    this.resumeHandler = () => this.poll()
    this.suspendHandler = () => this.applyStatus(false)

    this.deps.onResume(this.resumeHandler)
    this.deps.onSuspend(this.suspendHandler)
  }

  stop(): void {
    this.polling = false
    if (this.pollTimer) {
      clearTimeout(this.pollTimer)
      this.pollTimer = null
    }
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer)
      this.debounceTimer = null
    }
    if (this.resumeHandler) {
      this.deps.offResume(this.resumeHandler)
      this.resumeHandler = null
    }
    if (this.suspendHandler) {
      this.deps.offSuspend(this.suspendHandler)
      this.suspendHandler = null
    }
  }

  /**
   * Re-arms the poll at the cadence for the status we currently believe. A
   * self-rescheduling timeout rather than an interval so a status change can
   * switch cadence at once instead of after one tick at the old rate.
   */
  private schedulePoll(): void {
    if (!this.polling) return
    if (this.pollTimer) clearTimeout(this.pollTimer)
    const delay = this._online ? ONLINE_POLL_INTERVAL_MS : OFFLINE_POLL_INTERVAL_MS
    this.pollTimer = setTimeout(() => {
      this.pollTimer = null
      this.poll()
      this.schedulePoll()
    }, delay)
  }

  private poll(): void {
    const current = this.resolveOnlineStatus()
    if (current === this._online) {
      if (this.debounceTimer) {
        clearTimeout(this.debounceTimer)
        this.debounceTimer = null
      }
      return
    }
    this.debouncedApply(current)
  }

  private debouncedApply(status: boolean): void {
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer)
    }
    this.debounceTimer = setTimeout(() => {
      this.debounceTimer = null
      this.applyStatus(status)
    }, this.debounceMs)
  }

  private applyStatus(status: boolean): void {
    if (status === this._online) return
    this._online = status
    // Going offline must drop us onto the fast cadence immediately, so the
    // network coming back is still seen within OFFLINE_POLL_INTERVAL_MS.
    this.schedulePoll()
    this.emit('status-changed', { online: status })
  }

  private resolveOnlineStatus(): boolean {
    return this.onlineOverrideForTests ?? this.deps.getIsOnline()
  }
}
