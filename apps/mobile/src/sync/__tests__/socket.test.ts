import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { SyncSocketEvent } from '@memry/contracts/sync-socket'
import {
  MobileSyncSocket,
  PING_INTERVAL_MS,
  SOCKET_OPEN,
  WATCHDOG_MS,
  type HandshakeProbeResult,
  type SocketLike,
  type SyncSocketDeps
} from '../socket'

/**
 * A fake at the WebSocket seam.
 *
 * React Native's WebSocket cannot be constructed under node, and the whole
 * point of the manager taking `createSocket` is that everything above the
 * constructor is testable without a device. What is faked is one class; the
 * frame parsing, the state machine, the cadence and the backoff are shipped
 * code.
 */
class FakeSocket implements SocketLike {
  readyState = SOCKET_OPEN
  sent: string[] = []
  closedWith: { code?: number; reason?: string }[] = []
  onopen: (() => void) | null = null
  onmessage: ((event: { data: unknown }) => void) | null = null
  onerror: ((event: unknown) => void) | null = null
  onclose: ((event: { code?: number; reason?: string }) => void) | null = null

  constructor(
    readonly url: string,
    readonly headers: Record<string, string>
  ) {}

  send(data: string): void {
    this.sent.push(data)
  }

  close(code?: number, reason?: string): void {
    this.closedWith.push({ code, reason })
  }

  open(): void {
    this.onopen?.()
  }

  deliver(payload: unknown): void {
    this.onmessage?.({ data: typeof payload === 'string' ? payload : JSON.stringify(payload) })
  }

  serverClose(code?: number, reason?: string): void {
    this.onclose?.({ code, reason })
  }
}

interface Harness {
  socket: MobileSyncSocket
  sockets: FakeSocket[]
  events: SyncSocketEvent[]
  opens: number
  refreshes: number
  probes: string[]
}

function harness(overrides: Partial<SyncSocketDeps> = {}, probe?: HandshakeProbeResult): Harness {
  const sockets: FakeSocket[] = []
  const events: SyncSocketEvent[] = []
  const probes: string[] = []
  const state = { opens: 0, refreshes: 0 }

  const deps: SyncSocketDeps = {
    baseUrl: 'https://sync-staging.memrynote.com',
    getAccessToken: async () => 'jwt-token',
    refreshAccessToken: async () => {
      state.refreshes++
      return 'fresh-token'
    },
    getVaultId: () => 'vault-1',
    getAppVersion: () => '1.4.2+318',
    isOnline: () => true,
    log: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} },
    onEvent: (event) => events.push(event),
    onOpen: () => {
      state.opens++
    },
    createSocket: (url, headers) => {
      const created = new FakeSocket(url, headers)
      sockets.push(created)
      return created
    },
    probeHandshake: async (url) => {
      probes.push(url)
      return probe ?? null
    },
    // Jitter out, so a backoff assertion is about the curve and not the dice.
    random: () => 0,
    ...overrides
  }

  const socket = new MobileSyncSocket(deps)
  return {
    socket,
    sockets,
    events,
    probes,
    get opens() {
      return state.opens
    },
    get refreshes() {
      return state.refreshes
    }
  }
}

/** Let the token read and any probe settle without moving the clock. */
const settle = (): Promise<void> => vi.advanceTimersByTimeAsync(0).then(() => undefined)

async function connected(h: Harness): Promise<FakeSocket> {
  h.socket.start()
  await settle()
  const live = h.sockets[h.sockets.length - 1]
  live.open()
  return live
}

beforeEach(() => vi.useFakeTimers())
afterEach(() => vi.useRealTimers())

describe('handshake', () => {
  it('sends auth, a build-free version and the vault id as headers', async () => {
    const h = harness()
    const live = await connected(h)

    expect(live.url).toBe('wss://sync-staging.memrynote.com/sync/ws')
    expect(live.headers).toEqual({
      Authorization: 'Bearer jwt-token',
      // The server runs Number('2+318') -> NaN comparing versions, which makes
      // the gate pass by accident. The build half never goes on the wire.
      'X-App-Version': '1.4.2',
      // Omitting this leaves the socket connected and permanently deaf: the
      // Durable Object filters broadcasts by the socket's attached vault.
      'X-Memry-Vault-Id': 'vault-1'
    })
  })

  it('waits instead of connecting when offline, with no vault, or with no token', async () => {
    for (const override of [
      { isOnline: () => false },
      { getVaultId: () => null },
      { getAccessToken: async () => null }
    ] satisfies Partial<SyncSocketDeps>[]) {
      const h = harness(override)
      h.socket.start()
      await settle()
      expect(h.sockets).toHaveLength(0)
      // Armed, not abandoned. Returning bare here is what latches real-time
      // sync off for a whole session.
      await vi.advanceTimersByTimeAsync(1_000)
      expect(h.socket.connected).toBe(false)
    }
  })
})

describe('message routing', () => {
  it('hands the caller the frames it can act on', async () => {
    const h = harness()
    const live = await connected(h)

    live.deliver({ type: 'changes_available', payload: { cursor: 7, vaultId: 'vault-1' } })
    live.deliver({ type: 'crdt_updated', payload: { vaultId: 'vault-1', noteId: 'note-9' } })

    expect(h.events).toEqual([
      { kind: 'changes_available', cursor: 7, vaultId: 'vault-1' },
      { kind: 'crdt_updated', vaultId: 'vault-1', noteId: 'note-9' }
    ])
  })

  it('drops the keepalive answer, the unhandled types and anything unknown', async () => {
    const h = harness()
    const live = await connected(h)

    live.deliver('pong')
    live.deliver({ type: 'calendar_changes_available', payload: {} })
    live.deliver({ type: 'linking_request', payload: {} })
    live.deliver({ type: 'from_a_newer_server', payload: { anything: 1 } })
    live.deliver('not json at all')
    live.deliver({ type: 'crdt_updated', payload: {} })

    expect(h.events).toEqual([])
    expect(h.socket.connected).toBe(true)
  })

  it('reports every successful open so the caller can catch up', async () => {
    const h = harness()
    const live = await connected(h)
    expect(h.opens).toBe(1)

    live.serverClose(1006)
    await vi.advanceTimersByTimeAsync(1_000)
    h.sockets[1].open()
    // Each reconnect brackets a window of broadcasts nobody heard, so every
    // open has to trigger a catch-up, not just the first.
    expect(h.opens).toBe(2)
  })
})

describe('keepalive', () => {
  it('sends exactly the string Cloudflare auto-answers, every 25 s', async () => {
    const h = harness()
    const live = await connected(h)

    await vi.advanceTimersByTimeAsync(PING_INTERVAL_MS - 1)
    expect(live.sent).toEqual([])

    // Cloudflare answers this one payload from the hibernation auto-response
    // without waking the Durable Object, and that answer is also what keeps
    // the 31 s watchdog from tearing the socket down between beats.
    for (let beat = 0; beat < 3; beat++) {
      await vi.advanceTimersByTimeAsync(beat === 0 ? 1 : PING_INTERVAL_MS)
      live.deliver('pong')
    }
    // Any other payload wakes the Durable Object on every beat and spends the
    // socket's inbound rate-limit budget.
    expect(live.sent).toEqual(['ping', 'ping', 'ping'])
    expect(h.socket.connected).toBe(true)
  })

  it('never sends on a socket that is not open', async () => {
    const h = harness()
    const live = await connected(h)
    live.readyState = 0
    await vi.advanceTimersByTimeAsync(PING_INTERVAL_MS)
    // send() throws INVALID_STATE_ERR while CONNECTING, so the guard is load
    // bearing rather than defensive.
    expect(live.sent).toEqual([])
  })

  it('reconnects when nothing arrives for 31 s, and any frame defers that', async () => {
    const h = harness()
    const live = await connected(h)

    await vi.advanceTimersByTimeAsync(WATCHDOG_MS - 1_000)
    live.deliver('pong')
    await vi.advanceTimersByTimeAsync(WATCHDOG_MS - 1)
    expect(h.sockets).toHaveLength(1)

    await vi.advanceTimersByTimeAsync(1)
    expect(h.socket.connected).toBe(false)
    await vi.advanceTimersByTimeAsync(1_000)
    expect(h.sockets).toHaveLength(2)
  })
})

describe('backoff', () => {
  it('doubles per attempt and stops at 30 s', async () => {
    const h = harness()
    h.socket.start()
    await settle()

    const delays = [1_000, 2_000, 4_000, 8_000, 16_000, 30_000, 30_000]
    for (const [index, delay] of delays.entries()) {
      h.sockets[index].serverClose(1006)
      await settle()
      await vi.advanceTimersByTimeAsync(delay - 1)
      expect(h.sockets).toHaveLength(index + 1)
      await vi.advanceTimersByTimeAsync(1)
      expect(h.sockets).toHaveLength(index + 2)
    }
  })

  it('resets to the floor after a successful open', async () => {
    const h = harness()
    h.socket.start()
    await settle()
    h.sockets[0].serverClose(1006)
    await settle()
    await vi.advanceTimersByTimeAsync(1_000)
    h.sockets[1].serverClose(1006)
    await settle()
    await vi.advanceTimersByTimeAsync(2_000)

    h.sockets[2].open()
    h.sockets[2].serverClose(1006)
    await settle()
    await vi.advanceTimersByTimeAsync(1_000)
    expect(h.sockets).toHaveLength(4)
  })

  it('jumps to the ceiling when the server says rate limited', async () => {
    const h = harness()
    const live = await connected(h)
    // The handshake limit is 15 per 60 s keyed by USER, shared with every
    // other device that person owns.
    live.serverClose(4008)
    await settle()
    await vi.advanceTimersByTimeAsync(29_999)
    expect(h.sockets).toHaveLength(1)
    await vi.advanceTimersByTimeAsync(1)
    expect(h.sockets).toHaveLength(2)
  })
})

describe('close codes', () => {
  it('never reconnects after 4004 device revoked', async () => {
    const h = harness()
    const live = await connected(h)
    live.serverClose(4004, 'Device revoked')
    await settle()

    await vi.advanceTimersByTimeAsync(10 * 60_000)
    h.socket.start()
    await settle()
    await vi.advanceTimersByTimeAsync(10 * 60_000)
    expect(h.sockets).toHaveLength(1)
  })

  it('never reconnects after 4009 version incompatible', async () => {
    const h = harness()
    const live = await connected(h)
    live.serverClose(4009, 'App update required')
    await settle()

    await vi.advanceTimersByTimeAsync(10 * 60_000)
    h.socket.start()
    await settle()
    await vi.advanceTimersByTimeAsync(10 * 60_000)
    expect(h.sockets).toHaveLength(1)
  })

  it('refreshes the session then reconnects after 4003 token expired', async () => {
    const h = harness()
    const live = await connected(h)
    live.serverClose(4003)
    await settle()
    expect(h.refreshes).toBe(1)
    await vi.advanceTimersByTimeAsync(1_000)
    expect(h.sockets).toHaveLength(2)
  })

  it('lets the replacement win after 4001 rather than trading places with it', async () => {
    const h = harness()
    const live = await connected(h)
    live.serverClose(4001, 'Replaced by new connection')
    await settle()
    expect(h.sockets).toHaveLength(1)
    await vi.advanceTimersByTimeAsync(1_000)
    expect(h.sockets).toHaveLength(2)
  })
})

describe('rejected handshake', () => {
  it('probes over plain HTTP, because RN surfaces no status', async () => {
    const h = harness({}, { status: 426, code: 'SYNC_VERSION_INCOMPATIBLE' })
    h.socket.start()
    await settle()
    // Never opened, so the 1006 is a rejected handshake wearing a network error.
    h.sockets[0].serverClose(1006)
    await settle()

    expect(h.probes).toEqual(['https://sync-staging.memrynote.com/sync/ws'])
    await vi.advanceTimersByTimeAsync(10 * 60_000)
    expect(h.sockets).toHaveLength(1)
  })

  it('does not probe a socket that had opened', async () => {
    const h = harness()
    const live = await connected(h)
    live.serverClose(1006)
    await settle()
    expect(h.probes).toEqual([])
  })

  it('refreshes the token when the probe says 401', async () => {
    const h = harness({}, { status: 401, code: 'AUTH_INVALID_TOKEN' })
    h.socket.start()
    await settle()
    h.sockets[0].serverClose(1006)
    await settle()
    expect(h.refreshes).toBe(1)
    await vi.advanceTimersByTimeAsync(1_000)
    expect(h.sockets).toHaveLength(2)
  })

  it('latches off when the probe says the device is revoked', async () => {
    // The Durable Object answers 403 before the upgrade, so a revoked device
    // never reaches the 4004 close at all.
    const h = harness({}, { status: 403, code: 'AUTH_DEVICE_REVOKED' })
    h.socket.start()
    await settle()
    h.sockets[0].serverClose(1006)
    await settle()
    await vi.advanceTimersByTimeAsync(10 * 60_000)
    expect(h.sockets).toHaveLength(1)
  })
})

describe('stop', () => {
  it('closes the socket and ignores everything it emits afterwards', async () => {
    const h = harness()
    const live = await connected(h)
    h.socket.stop()

    expect(live.closedWith).toEqual([{ code: 1000, reason: 'client teardown' }])
    // A dead socket can sit in CLOSING until the OS times out; whatever it
    // emits from there belongs to a connection nobody is listening to.
    live.serverClose(1006)
    live.deliver({ type: 'changes_available', payload: { cursor: 1 } })
    await vi.advanceTimersByTimeAsync(10 * 60_000)
    expect(h.events).toEqual([])
    expect(h.sockets).toHaveLength(1)
    expect(h.socket.connected).toBe(false)
  })

  it('stops the keepalive', async () => {
    const h = harness()
    const live = await connected(h)
    h.socket.stop()
    await vi.advanceTimersByTimeAsync(PING_INTERVAL_MS * 3)
    expect(live.sent).toEqual([])
  })

  it('drops a connect that was in flight when the app backgrounded', async () => {
    let release: (token: string) => void = () => {}
    const h = harness({
      getAccessToken: () => new Promise<string>((resolve) => (release = resolve))
    })
    h.socket.start()
    h.socket.stop()
    release('jwt-token')
    await settle()
    expect(h.sockets).toHaveLength(0)
  })

  it('reconnects on a later start', async () => {
    const h = harness()
    await connected(h)
    h.socket.stop()
    h.socket.start()
    await settle()
    h.sockets[1].open()
    expect(h.socket.connected).toBe(true)
  })
})

describe('refreshAuth', () => {
  it('extends the live socket in place', async () => {
    const h = harness()
    const live = await connected(h)
    h.socket.refreshAuth('fresh-token')
    expect(live.sent.map((raw) => JSON.parse(raw))).toEqual([
      { type: 'auth', payload: { token: 'fresh-token' } }
    ])
  })

  it('is a no-op with no live socket', async () => {
    const h = harness()
    h.socket.refreshAuth('fresh-token')
    await settle()
    expect(h.sockets).toHaveLength(0)
  })
})
