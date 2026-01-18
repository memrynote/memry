/**
 * Network Status Monitor
 *
 * Monitors network connectivity and emits events when status changes.
 * Used by the sync engine to determine when to attempt sync operations.
 *
 * Features:
 * - Uses Electron's net.isOnline() for reliable detection
 * - Listens to system online/offline events
 * - Debounces status changes to avoid flapping
 * - Emits events for sync engine to react to
 *
 * @module main/sync/network
 */

import { EventEmitter } from 'events'

// =============================================================================
// Types
// =============================================================================

/** Network status */
export type NetworkStatus = 'online' | 'offline' | 'unknown'

/** Network status change event */
export interface NetworkStatusEvent {
  status: NetworkStatus
  previousStatus: NetworkStatus
  timestamp: number
}

/** Network monitor events */
export interface NetworkMonitorEvents {
  online: () => void
  offline: () => void
  'status-changed': (event: NetworkStatusEvent) => void
}

// =============================================================================
// Constants
// =============================================================================

/** Debounce delay for status changes (ms) */
const STATUS_DEBOUNCE_MS = 2000

/** Polling interval for connectivity check (ms) */
const POLL_INTERVAL_MS = 30000

// =============================================================================
// Network Monitor Class
// =============================================================================

/**
 * Network Status Monitor
 *
 * Monitors network connectivity and provides reliable online/offline detection.
 */
export class NetworkMonitor extends EventEmitter {
  private _status: NetworkStatus = 'unknown'
  private _isStarted: boolean = false
  private _debounceTimer: NodeJS.Timeout | null = null
  private _pollTimer: NodeJS.Timeout | null = null
  private _pendingStatus: NetworkStatus | null = null

  // ---------------------------------------------------------------------------
  // Lifecycle
  // ---------------------------------------------------------------------------

  /**
   * Start monitoring network status.
   *
   * Begins listening to system events and polling for connectivity.
   */
  start(): void {
    if (this._isStarted) return
    this._isStarted = true

    // Set initial status
    this._status = this.checkOnline() ? 'online' : 'offline'

    // Listen to system events
    if (typeof window !== 'undefined') {
      // Renderer process or browser
      window.addEventListener('online', this.handleOnline)
      window.addEventListener('offline', this.handleOffline)
    }

    // Start polling for connectivity
    this._pollTimer = setInterval(() => {
      this.poll()
    }, POLL_INTERVAL_MS)

    // Emit initial status
    this.emit('status-changed', {
      status: this._status,
      previousStatus: 'unknown',
      timestamp: Date.now()
    })

    if (this._status === 'online') {
      this.emit('online')
    } else {
      this.emit('offline')
    }
  }

  /**
   * Stop monitoring network status.
   *
   * Removes event listeners and stops polling.
   */
  stop(): void {
    if (!this._isStarted) return
    this._isStarted = false

    // Remove event listeners
    if (typeof window !== 'undefined') {
      window.removeEventListener('online', this.handleOnline)
      window.removeEventListener('offline', this.handleOffline)
    }

    // Clear timers
    if (this._debounceTimer) {
      clearTimeout(this._debounceTimer)
      this._debounceTimer = null
    }

    if (this._pollTimer) {
      clearInterval(this._pollTimer)
      this._pollTimer = null
    }

    this._pendingStatus = null
  }

  // ---------------------------------------------------------------------------
  // Status Access
  // ---------------------------------------------------------------------------

  /**
   * Get current network status.
   *
   * @returns Current network status
   */
  get status(): NetworkStatus {
    return this._status
  }

  /**
   * Check if currently online.
   *
   * @returns True if online
   */
  get isOnline(): boolean {
    return this._status === 'online'
  }

  /**
   * Check if currently offline.
   *
   * @returns True if offline
   */
  get isOffline(): boolean {
    return this._status === 'offline'
  }

  /**
   * Check if monitor is running.
   *
   * @returns True if started
   */
  get isStarted(): boolean {
    return this._isStarted
  }

  // ---------------------------------------------------------------------------
  // Event Handlers
  // ---------------------------------------------------------------------------

  /**
   * Handle system online event.
   */
  private handleOnline = (): void => {
    this.setStatus('online')
  }

  /**
   * Handle system offline event.
   */
  private handleOffline = (): void => {
    this.setStatus('offline')
  }

  // ---------------------------------------------------------------------------
  // Internal Methods
  // ---------------------------------------------------------------------------

  /**
   * Check if the system is online using Electron's API or navigator.
   *
   * @returns True if online
   */
  private checkOnline(): boolean {
    // Try Electron's net module first (main process)
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { net } = require('electron')
      return net.isOnline()
    } catch {
      // Not in Electron main process
    }

    // Try navigator.onLine (browser/renderer)
    if (typeof navigator !== 'undefined') {
      return navigator.onLine
    }

    // Assume online if we can't determine
    return true
  }

  /**
   * Set the network status with debouncing.
   *
   * @param newStatus - New status to set
   */
  private setStatus(newStatus: NetworkStatus): void {
    // If same as current, ignore
    if (newStatus === this._status) {
      this._pendingStatus = null
      if (this._debounceTimer) {
        clearTimeout(this._debounceTimer)
        this._debounceTimer = null
      }
      return
    }

    // Store pending status
    this._pendingStatus = newStatus

    // Clear existing debounce timer
    if (this._debounceTimer) {
      clearTimeout(this._debounceTimer)
    }

    // Debounce the status change
    this._debounceTimer = setTimeout(() => {
      this.applyStatusChange()
    }, STATUS_DEBOUNCE_MS)
  }

  /**
   * Apply a pending status change.
   */
  private applyStatusChange(): void {
    const newStatus = this._pendingStatus
    if (!newStatus || newStatus === this._status) {
      this._pendingStatus = null
      return
    }

    const previousStatus = this._status
    this._status = newStatus
    this._pendingStatus = null
    this._debounceTimer = null

    // Emit events
    this.emit('status-changed', {
      status: newStatus,
      previousStatus,
      timestamp: Date.now()
    })

    if (newStatus === 'online') {
      this.emit('online')
    } else if (newStatus === 'offline') {
      this.emit('offline')
    }
  }

  /**
   * Poll for connectivity.
   *
   * Used as a backup in case system events are missed.
   */
  private poll(): void {
    const isOnline = this.checkOnline()
    const newStatus: NetworkStatus = isOnline ? 'online' : 'offline'

    if (newStatus !== this._status) {
      this.setStatus(newStatus)
    }
  }

  /**
   * Force an immediate status check.
   *
   * @returns Current status after check
   */
  forceCheck(): NetworkStatus {
    const isOnline = this.checkOnline()
    const newStatus: NetworkStatus = isOnline ? 'online' : 'offline'

    // Apply immediately without debounce
    if (newStatus !== this._status) {
      const previousStatus = this._status
      this._status = newStatus

      this.emit('status-changed', {
        status: newStatus,
        previousStatus,
        timestamp: Date.now()
      })

      if (newStatus === 'online') {
        this.emit('online')
      } else {
        this.emit('offline')
      }
    }

    return this._status
  }
}

// =============================================================================
// Singleton Instance
// =============================================================================

/** Singleton network monitor instance */
let _networkMonitor: NetworkMonitor | null = null

/**
 * Get the network monitor singleton.
 *
 * @returns NetworkMonitor instance
 */
export function getNetworkMonitor(): NetworkMonitor {
  if (!_networkMonitor) {
    _networkMonitor = new NetworkMonitor()
  }
  return _networkMonitor
}

/**
 * Reset the network monitor singleton (for testing).
 */
export function resetNetworkMonitor(): void {
  if (_networkMonitor) {
    _networkMonitor.stop()
    _networkMonitor.removeAllListeners()
    _networkMonitor = null
  }
}
