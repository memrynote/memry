import {
  parseSyncSocketFrame,
  syncSocketAuthFrame,
  SYNC_SOCKET_CLOSE,
  SYNC_SOCKET_PING,
  type SyncSocketEvent
} from '@memry/contracts/sync-socket'
import type { SyncLogger } from '@memry/sync-client/adapters'

/**
 * The phone's half of `GET /sync/ws`.
 *
 * Without it the app had no live sync at all: nothing pushed and nothing
 * pulled while it sat in the foreground, and a body-only edit from another
 * device had no route to arrive, because `crdt_updated` is broadcast over this
 * socket and nowhere else.
 *
 * Everything it touches is injected. `@react-native-community/netinfo` is
 * imported at module scope by the http client, which is why the trigger
 * surface had no tests at all; this file must stay reachable from a plain
 * node run.
 */

export const WATCHDOG_MS = 31_000
export const PING_INTERVAL_MS = 25_000
export const BASE_RECONNECT_DELAY_MS = 1_000
export const MAX_RECONNECT_DELAY_MS = 30_000
export const RECONNECT_JITTER_MS = 500

/**
 * The backoff attempt a rate-limited close jumps to.
 *
 * The handshake limit is 15 per 60 seconds keyed by USER and shared across all
 * their devices, so a phone that keeps retrying spends a budget its owner's
 * laptop also needs. 5 puts the next delay at the 30 s ceiling.
 */
export const RATE_LIMITED_ATTEMPT = 5

/** `WebSocket.OPEN`. `send()` throws INVALID_STATE_ERR in any other state. */
export const SOCKET_OPEN = 1

/**
 * The slice of React Native's WebSocket this manager uses.
 *
 * RN has no `terminate()`, no ping/pong events and no 'unexpected-response';
 * a rejected handshake surfaces as a bare error and a synthetic 1006 close
 * with the HTTP status nowhere in reach. Narrowing to what actually exists
 * keeps the desktop manager's shape from being copied in by habit.
 */
export interface SocketLike {
  readyState: number
  send(data: string): void
  close(code?: number, reason?: string): void
  onopen: (() => void) | null
  onmessage: ((event: { data: unknown }) => void) | null
  onerror: ((event: unknown) => void) | null
  onclose: ((event: { code?: number; reason?: string }) => void) | null
}

export interface HandshakeProbeResult {
  status: number
  code?: string
}

export interface SyncSocketDeps {
  /** The https sync base url. The ws url and the probe url derive from it. */
  baseUrl: string
  getAccessToken: () => Promise<string | null>
  refreshAccessToken: () => Promise<string | null>
  getVaultId: () => string | null
  /** `<semver>` or `<semver>+<build>`; the build half is stripped for the header. */
  getAppVersion: () => string
  isOnline: () => boolean
  log: SyncLogger
  onEvent: (event: SyncSocketEvent) => void
  /** Every successful open brackets a window of broadcasts nobody heard. */
  onOpen: () => void
  createSocket: (url: string, headers: Record<string, string>) => SocketLike
  probeHandshake?: (
    url: string,
    headers: Record<string, string>
  ) => Promise<HandshakeProbeResult | null>
  random?: () => number
}

/**
 * Why the manager will never reconnect again this session.
 *
 * Both are server verdicts about this install rather than this attempt, so
 * retrying cannot change the answer and would only spend the shared handshake
 * budget. Clearing them takes a new app launch, which is the same thing as a
 * new token or a new binary.
 */
type LatchReason = 'device-revoked' | 'version-incompatible'

/**
 * One state, not the four booleans the desktop manager grew.
 *
 * `shouldBeConnected`, `authFailed`, `versionRejected` and `certPinFailed` can
 * express combinations that mean nothing, and every guard had to spell all
 * four out. Here "may I connect" is `kind !== 'stopped' && kind !== 'latched'`.
 */
type SocketState =
  | { kind: 'stopped' }
  | { kind: 'connecting' }
  | { kind: 'open' }
  | { kind: 'waiting' }
  | { kind: 'latched'; why: LatchReason }

export class MobileSyncSocket {
  private state: SocketState = { kind: 'stopped' }
  private socket: SocketLike | null = null
  private attempt = 0
  private watchdog: ReturnType<typeof setTimeout> | null = null
  private pingTimer: ReturnType<typeof setInterval> | null = null
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null
  /**
   * Bumped by every `stop()` and every teardown. An in-flight `connect()` is
   * awaiting a keychain read and a token refresh when the user backgrounds the
   * app, and without this it would happily create a socket afterwards.
   */
  private generation = 0
  private readonly random: () => number

  constructor(private readonly deps: SyncSocketDeps) {
    this.random = deps.random ?? Math.random
  }

  get connected(): boolean {
    return this.state.kind === 'open'
  }

  start(): void {
    if (this.state.kind === 'latched') {
      this.deps.log.debug?.('Socket start ignored', { latched: this.state.why })
      return
    }
    if (this.state.kind === 'connecting' || this.state.kind === 'open') return
    this.clearReconnectTimer()
    void this.connect()
  }

  /**
   * Deliberate teardown, and it must be deliberate on backgrounding.
   *
   * Letting iOS tear the socket down instead delivers a close we cannot tell
   * from a network failure, which arms the backoff and then burns handshake
   * attempts reconnecting a socket the app is not even foregrounded to use.
   */
  stop(): void {
    this.generation++
    this.teardown()
    this.clearReconnectTimer()
    this.attempt = 0
    if (this.state.kind !== 'latched') this.state = { kind: 'stopped' }
  }

  /** Extend the live socket's expiry in place after a token refresh. */
  refreshAuth(token: string): void {
    if (this.state.kind !== 'open') return
    this.send(syncSocketAuthFrame(token))
  }

  private async readAccessToken(): Promise<string | null> {
    try {
      return await this.deps.getAccessToken()
    } catch (err) {
      this.deps.log.warn('Socket token read failed', { error: message(err) })
      return null
    }
  }

  private async connect(): Promise<void> {
    const generation = this.generation
    this.state = { kind: 'connecting' }

    if (!this.deps.isOnline()) return this.scheduleReconnect()

    const vaultId = this.deps.getVaultId()
    if (!vaultId) return this.scheduleReconnect()

    const credential = await this.readAccessToken()
    // A token read that came back empty must still arm a retry. Returning bare
    // latches real-time sync off for the session, and it latches exactly when
    // it hurts: /auth/refresh lives on the server this device cannot reach.
    if (!credential) return this.scheduleReconnect()
    if (generation !== this.generation) return

    const headers = this.headers(credential, vaultId)
    let socket: SocketLike
    try {
      socket = this.deps.createSocket(this.wsUrl(), headers)
    } catch (err) {
      this.deps.log.warn('Socket construction failed', { error: message(err) })
      return this.scheduleReconnect()
    }
    this.socket = socket

    let opened = false
    const mine = (): boolean => this.socket === socket && generation === this.generation

    socket.onopen = () => {
      if (!mine()) return
      opened = true
      this.state = { kind: 'open' }
      this.attempt = 0
      this.resetWatchdog()
      this.startPing()
      this.deps.log.info('Sync socket connected')
      this.deps.onOpen()
    }

    socket.onmessage = (event) => {
      if (!mine()) return
      // ANY inbound frame proves the connection is alive, including the
      // keepalive answer and a message this build does not understand.
      this.resetWatchdog()
      if (typeof event.data !== 'string') return
      const parsed = parseSyncSocketFrame(event.data)
      if (!parsed) {
        this.deps.log.warn('Unparseable socket frame')
        return
      }
      if (parsed.kind === 'ignored') return
      this.deps.onEvent(parsed)
    }

    socket.onerror = (event) => {
      if (!mine()) return
      // RN gives no HTTP status here and no 'unexpected-response' event. The
      // close that follows owns the decision; this line is for the log only.
      this.deps.log.debug?.('Sync socket error', { error: errorText(event) })
    }

    socket.onclose = (event) => {
      if (!mine()) return
      this.handleClose(event?.code, event?.reason, opened, headers)
    }
  }

  private handleClose(
    code: number | undefined,
    reason: string | undefined,
    opened: boolean,
    headers: Record<string, string>
  ): void {
    this.teardown()
    this.deps.log.info('Sync socket disconnected', { code, reason })

    switch (code) {
      case SYNC_SOCKET_CLOSE.deviceRevoked:
        return this.latch('device-revoked')
      case SYNC_SOCKET_CLOSE.versionIncompatible:
        return this.latch('version-incompatible')
      case SYNC_SOCKET_CLOSE.tokenExpired:
        void this.deps
          .refreshAccessToken()
          .catch(() => null)
          .finally(() => this.scheduleReconnect())
        return
      case SYNC_SOCKET_CLOSE.rateLimited:
        this.attempt = Math.max(this.attempt, RATE_LIMITED_ATTEMPT)
        return this.scheduleReconnect()
      case SYNC_SOCKET_CLOSE.replaced:
        // Another connection for this device took over. That one is now the
        // live socket, so reconnecting here just replaces it back and the two
        // trade places forever. Back off like any other close and let the
        // loser lose.
        return this.scheduleReconnect()
      default:
        break
    }

    if (opened) return this.scheduleReconnect()

    // Never opened, so this is a rejected handshake wearing a 1006. The status
    // is not structurally available and the message is not worth string
    // matching, so ask the same URL over plain HTTP what it would have said.
    void this.diagnoseHandshake(headers).finally(() => this.scheduleReconnect())
  }

  private async diagnoseHandshake(headers: Record<string, string>): Promise<void> {
    const probe = this.deps.probeHandshake ?? defaultProbe
    let result: HandshakeProbeResult | null = null
    try {
      result = await probe(this.probeUrl(), headers)
    } catch (err) {
      this.deps.log.debug?.('Handshake probe failed', { error: message(err) })
      return
    }
    if (!result) return
    this.deps.log.warn('Sync socket handshake rejected', {
      status: result.status,
      code: result.code ?? 'unknown'
    })

    switch (result.status) {
      case 401:
        // The token was stale by the time the handshake ran. Refresh now so
        // the scheduled reconnect has something usable to present.
        await this.deps.refreshAccessToken().catch(() => null)
        return
      case 403:
        // The Durable Object answers 403 AUTH_DEVICE_REVOKED before the
        // upgrade, so this device never reaches the 4004 close at all.
        if (result.code === 'AUTH_DEVICE_REVOKED') this.latch('device-revoked')
        return
      case 426:
        return this.latch('version-incompatible')
      case 402:
      case 429:
        // Plan gate and rate limit are both "not now" rather than "not ever" —
        // an upgrade or a cooled window heals within the 30 s ceiling without
        // needing the app relaunched.
        this.attempt = Math.max(this.attempt, RATE_LIMITED_ATTEMPT)
        return
      default:
        return
    }
  }

  private latch(why: LatchReason): void {
    this.state = { kind: 'latched', why }
    this.clearReconnectTimer()
    this.deps.log.warn('Sync socket latched off for this session', { reason: why })
  }

  private scheduleReconnect(): void {
    if (this.state.kind === 'stopped' || this.state.kind === 'latched') return
    this.clearReconnectTimer()
    this.state = { kind: 'waiting' }

    const delay = Math.min(
      BASE_RECONNECT_DELAY_MS * 2 ** this.attempt + this.random() * RECONNECT_JITTER_MS,
      MAX_RECONNECT_DELAY_MS
    )
    this.attempt++

    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null
      if (this.state.kind !== 'waiting') return
      void this.connect()
    }, delay)
  }

  private startPing(): void {
    this.stopPing()
    this.pingTimer = setInterval(() => this.send(SYNC_SOCKET_PING), PING_INTERVAL_MS)
  }

  private send(data: string): void {
    const socket = this.socket
    if (!socket || socket.readyState !== SOCKET_OPEN) return
    try {
      socket.send(data)
    } catch (err) {
      this.deps.log.debug?.('Socket send failed', { error: message(err) })
    }
  }

  private resetWatchdog(): void {
    this.clearWatchdog()
    this.watchdog = setTimeout(() => {
      this.watchdog = null
      this.deps.log.warn('Sync socket went quiet; reconnecting')
      this.teardown()
      this.scheduleReconnect()
    }, WATCHDOG_MS)
  }

  /**
   * Drop the socket and every timer it owns.
   *
   * The reference is nulled and the handlers detached BEFORE close, because
   * there is no terminate() on React Native and a dead socket can sit in
   * CLOSING until the OS gives up on it. Anything it emits after this point
   * belongs to a connection nobody is listening to.
   */
  private teardown(): void {
    const socket = this.socket
    this.socket = null
    this.clearWatchdog()
    this.stopPing()
    if (!socket) return
    socket.onopen = null
    socket.onmessage = null
    socket.onerror = null
    socket.onclose = null
    try {
      socket.close(1000, 'client teardown')
    } catch {
      // A socket already closing throws on some RN versions; nothing to do.
    }
  }

  private headers(token: string, vaultId: string): Record<string, string> {
    return {
      Authorization: `Bearer ${token}`,
      // The build half is stripped deliberately. The server compares with
      // isVersionBelow, which runs Number('0+1') -> NaN on a `+build` suffix
      // and lets the version gate pass by accident.
      'X-App-Version': this.deps.getAppVersion().split('+')[0],
      // Without this the socket connects and is then permanently deaf: the
      // Durable Object filters every broadcast by the socket's attached vault.
      'X-Memry-Vault-Id': vaultId
    }
  }

  private wsUrl(): string {
    return this.deps.baseUrl.replace(/^http/, 'ws') + '/sync/ws'
  }

  private probeUrl(): string {
    return this.deps.baseUrl + '/sync/ws'
  }

  private stopPing(): void {
    if (this.pingTimer) {
      clearInterval(this.pingTimer)
      this.pingTimer = null
    }
  }

  private clearWatchdog(): void {
    if (this.watchdog) {
      clearTimeout(this.watchdog)
      this.watchdog = null
    }
  }

  private clearReconnectTimer(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer)
      this.reconnectTimer = null
    }
  }
}

async function defaultProbe(
  url: string,
  headers: Record<string, string>
): Promise<HandshakeProbeResult | null> {
  const response = await fetch(url, { method: 'GET', headers })
  let code: string | undefined
  try {
    const body = (await response.json()) as { error?: { code?: string } }
    code = body?.error?.code
  } catch {
    code = undefined
  }
  return { status: response.status, code }
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

function errorText(event: unknown): string {
  if (event instanceof Error) return event.message
  if (event && typeof event === 'object' && 'message' in event) {
    return String((event as { message: unknown }).message)
  }
  return 'unknown'
}
