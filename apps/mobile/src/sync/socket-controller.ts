import { createMobileHttpClient } from '../adapters/http-client'
import { mobileAppVersion } from '../adapters/runtime'
import { refreshOpenDocsFor } from '../editor/session'
import { createLogger } from '../lib/logger'
import { loadSession, refreshSession } from './auth-client'
import { getSyncEngine } from './engine'
import { MobileSyncSocket, type SocketLike } from './socket'
import { syncBaseUrl } from './server-config'
import { requestVaultSync } from './triggers'

const log = createLogger('SyncSocket')

/**
 * React Native's WebSocket takes a third `options` argument the DOM lib knows
 * nothing about, and it is the ONLY way to get headers onto the handshake.
 * Auth on `/sync/ws` is headers or nothing; there is no query param and no
 * subprotocol. `Libraries/WebSocket/WebSocket.js` in react-native 0.86.2
 * destructures `options.headers` and hands it to
 * `NativeWebSocketModule.connect(url, protocols, {headers}, id)`, and it
 * normalises a non-array `protocols` to null, so both arguments below are as
 * the runtime wants them.
 */
type RNWebSocketConstructor = new (
  url: string,
  protocols: string[] | null,
  options: { headers: Record<string, string> }
) => SocketLike

const RNWebSocket = WebSocket as unknown as RNWebSocketConstructor

/**
 * The app's single sync socket, and the only place module singletons meet
 * `MobileSyncSocket`. Everything the manager itself needs is injected here so
 * the manager stays testable without NetInfo or the keychain.
 */

let socket: MobileSyncSocket | null = null
let activeVaultId: string | null = null

async function currentAccessToken(): Promise<string | null> {
  const session = await loadSession()
  return session?.accessToken ?? null
}

function build(): MobileSyncSocket {
  const online = createMobileHttpClient(syncBaseUrl())
  let isOnline = true
  online.onOnlineChanged((next) => {
    isOnline = next
  })

  return new MobileSyncSocket({
    baseUrl: syncBaseUrl(),
    getAccessToken: currentAccessToken,
    refreshAccessToken: () => refreshSession(),
    getVaultId: () => activeVaultId,
    getAppVersion: mobileAppVersion,
    isOnline: () => isOnline,
    log,
    createSocket: (url, headers) => new RNWebSocket(url, null, { headers }),
    onOpen: () => {
      const vaultId = activeVaultId
      if (!vaultId) return
      // Every reconnect brackets a window in which broadcasts were missed, and
      // a missed `crdt_updated` is gone for good — the server keeps no
      // vault-wide CRDT cursor to ask for it again.
      void requestVaultSync(vaultId, 'socket')
    },
    onEvent: (event) => {
      const vaultId = activeVaultId
      if (!vaultId) return
      // The Durable Object already filters by the socket's attached vault, so
      // this only catches a frame in flight across a vault switch.
      if ('vaultId' in event && event.vaultId && event.vaultId !== vaultId) return

      switch (event.kind) {
        case 'changes_available':
          void requestVaultSync(vaultId, 'socket')
          return
        case 'crdt_updated':
          void pullBody(vaultId, event.noteId)
          return
        case 'error':
          log.warn('Sync socket server error', {
            code: event.code ?? 'unknown',
            message: event.message ?? ''
          })
          return
        default:
          return
      }
    }
  })
}

/**
 * Fetch one note body, then feed it to the editor if that note is open.
 *
 * Goes through the engine rather than `CrdtBodyPuller` directly: both engine
 * methods wrap themselves in `exclusive()`, and reaching past them reopens the
 * first-sync cursor wedge, because `runFirstSyncIfNeeded` shares the
 * `sync_cursors` row with `pullIncremental`.
 */
async function pullBody(vaultId: string, noteId: string): Promise<void> {
  try {
    const engine = getSyncEngine(vaultId)
    const store = await engine.getStore()
    if (!store) return
    await engine.pullBodiesFor(store, [noteId])
    // The doc manager caches docs for the process lifetime, so a pull that
    // lands new server rows is invisible on screen until this runs.
    await refreshOpenDocsFor(vaultId, [noteId])
  } catch (err) {
    log.warn('Socket-driven body pull failed', {
      noteId,
      error: err instanceof Error ? err.message : String(err)
    })
  }
}

/** Connect, or reconnect against a different vault. Safe to call repeatedly. */
export function startSyncSocket(vaultId: string): void {
  if (socket && activeVaultId !== vaultId) stopSyncSocket()
  activeVaultId = vaultId
  socket ??= build()
  socket.start()
}

/**
 * Disconnect deliberately.
 *
 * Called on backgrounding as well as teardown. Letting iOS tear the socket
 * down instead delivers a close indistinguishable from a network failure,
 * which arms the backoff and then spends the handshake budget -- 15 per 60
 * seconds, keyed by USER and shared with every other device they own --
 * reconnecting a socket the app is not foregrounded to use.
 */
export function stopSyncSocket(): void {
  socket?.stop()
}
