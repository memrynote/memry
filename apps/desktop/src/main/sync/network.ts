import { EventEmitter } from 'events'

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

const POLL_INTERVAL_MS = 5000
const DEFAULT_DEBOUNCE_MS = 2000
const MAX_NETWORK_MONITOR_LISTENERS = 50

export class NetworkMonitor extends EventEmitter {
  private _online: boolean
  private onlineOverrideForTests: boolean | null = null
  private pollTimer: ReturnType<typeof setInterval> | null = null
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
    this.pollTimer = setInterval(() => this.poll(), POLL_INTERVAL_MS)

    this.resumeHandler = () => this.poll()
    this.suspendHandler = () => this.applyStatus(false)

    this.deps.onResume(this.resumeHandler)
    this.deps.onSuspend(this.suspendHandler)
  }

  stop(): void {
    if (this.pollTimer) {
      clearInterval(this.pollTimer)
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
    this.emit('status-changed', { online: status })
  }

  private resolveOnlineStatus(): boolean {
    return this.onlineOverrideForTests ?? this.deps.getIsOnline()
  }
}
