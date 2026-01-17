/**
 * Linking Poller
 *
 * Polls the server for device linking session status changes.
 * Used to detect when:
 * - New device scans QR (existing device receives proof data)
 * - Existing device approves (new device can complete linking)
 * - Session is rejected or expires
 *
 * @module main/sync/linking-poller
 */

import { syncApi, type LinkingStatusResponse } from './api-client'

// =============================================================================
// Types
// =============================================================================

export type LinkingStatus =
  | 'pending'
  | 'scanned'
  | 'approved'
  | 'completed'
  | 'rejected'
  | 'expired'

export interface LinkingPollerConfig {
  /** Session ID to poll */
  sessionId: string

  /** Role determines what status transitions to watch for */
  role: 'existing' | 'new'

  /** Polling interval in milliseconds (default: 2500ms) */
  intervalMs?: number

  /** Session expiry timestamp (ms since epoch) */
  expiresAt: number

  /** Access token for authenticated requests (existing device only) */
  accessToken?: string

  /** QR token for authenticated requests (new device only) */
  qrToken?: string

  /** Called when status changes */
  onStatusChange: (status: LinkingStatusResponse) => void

  /** Called on polling errors */
  onError: (error: Error) => void

  /** Called when session expires (local or server-detected) */
  onExpired: () => void
}

// =============================================================================
// LinkingPoller Class
// =============================================================================

/**
 * Polling manager for device linking sessions.
 *
 * Polls the server at regular intervals and invokes callbacks when
 * status transitions occur. Auto-stops on terminal states.
 */
export class LinkingPoller {
  private intervalId: NodeJS.Timeout | null = null
  private lastStatus: LinkingStatus | null = null
  private stopped = false
  private readonly intervalMs: number

  constructor(private readonly config: LinkingPollerConfig) {
    this.intervalMs = config.intervalMs ?? 2500
  }

  /**
   * Start polling.
   *
   * Performs an immediate poll, then continues at the configured interval.
   */
  start(): void {
    if (this.stopped) {
      return
    }

    // Immediate first poll
    void this.poll()

    // Start interval
    this.intervalId = setInterval(() => {
      if (!this.stopped) {
        void this.poll()
      }
    }, this.intervalMs)
  }

  /**
   * Stop polling.
   *
   * Clears the interval and prevents future polls.
   */
  stop(): void {
    this.stopped = true
    if (this.intervalId) {
      clearInterval(this.intervalId)
      this.intervalId = null
    }
  }

  /**
   * Check if the poller is currently active.
   */
  isActive(): boolean {
    return !this.stopped && this.intervalId !== null
  }

  /**
   * Get the last known status.
   */
  getLastStatus(): LinkingStatus | null {
    return this.lastStatus
  }

  // ---------------------------------------------------------------------------
  // Private Methods
  // ---------------------------------------------------------------------------

  private async poll(): Promise<void> {
    // Check local expiry before making request
    if (Date.now() > this.config.expiresAt) {
      this.stop()
      this.config.onExpired()
      return
    }

    try {
      // Build auth parameter based on role
      const auth = this.config.accessToken
        ? { accessToken: this.config.accessToken }
        : this.config.qrToken
          ? { qrToken: this.config.qrToken }
          : undefined

      const status = await syncApi.instance.getLinkingStatus(this.config.sessionId, auth)

      // Check for status change
      if (status.status !== this.lastStatus) {
        const previousStatus = this.lastStatus
        this.lastStatus = status.status

        // Only notify on actual changes (not first poll unless it's already a terminal state)
        if (previousStatus !== null || this.isTerminalOrActionable(status.status)) {
          this.config.onStatusChange(status)
        } else {
          // First poll, store initial status but don't notify (unless terminal)
          this.lastStatus = status.status
        }

        // Auto-stop on terminal states
        if (this.isTerminal(status.status)) {
          this.stop()
          if (status.status === 'expired') {
            this.config.onExpired()
          }
        }
      }
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error))

      // Check for definitive errors that should stop polling
      if (this.isDefinitiveError(err)) {
        this.stop()
        this.config.onExpired()
      } else {
        // Transient error - notify but keep polling
        this.config.onError(err)
      }
    }
  }

  /**
   * Check if status is a terminal state (no more transitions possible).
   */
  private isTerminal(status: LinkingStatus): boolean {
    return ['completed', 'rejected', 'expired'].includes(status)
  }

  /**
   * Check if status is terminal or requires action.
   *
   * For first poll, we only want to notify if it's:
   * - Terminal (completed, rejected, expired)
   * - Actionable (scanned for existing device, approved for new device)
   */
  private isTerminalOrActionable(status: LinkingStatus): boolean {
    if (this.isTerminal(status)) {
      return true
    }

    // For existing device, 'scanned' is actionable
    if (this.config.role === 'existing' && status === 'scanned') {
      return true
    }

    // For new device, 'approved' is actionable
    if (this.config.role === 'new' && status === 'approved') {
      return true
    }

    return false
  }

  /**
   * Check if an error indicates the session no longer exists or is invalid.
   */
  private isDefinitiveError(error: Error): boolean {
    const message = error.message.toLowerCase()
    return (
      message.includes('not found') ||
      message.includes('session not found') ||
      message.includes('expired') ||
      message.includes('404')
    )
  }
}
