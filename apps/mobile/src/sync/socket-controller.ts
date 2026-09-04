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

/**
 * How long a burst of broadcasts is gathered before it is acted on.
 *
 * The server sends one `crdt_updated` per note per accepted push, so a desktop
 * pushing fifty notes delivers fifty frames. Acting on each one directly meant
 * fifty single-note HTTP round trips chained behind each other through the
 * engine's FIFO queue, which is not a coalescer. Imperceptible as latency,
 * and it turns a batch into one request.
 */
const COALESCE_MS = 250

let socket: MobileSyncSocket | null = null
let activeVaultId: string | null = null
const pendingNoteIds = new Set<string>()
let bodyTimer: ReturnType<typeof setTimeout> | null = null
let passTimer: ReturnType<typeof setTimeout> | null = null

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
      // Every reconnect brackets a window in which broadcasts were missed, and
      // a missed `crdt_updated` is gone for good — the server keeps no
      // vault-wide CRDT cursor to ask for it again.
      schedulePass()
    },
    onEvent: (event) => {
      const vaultId = activeVaultId
      if (!vaultId) return
      // The Durable Object already filters by the socket's attached vault, so
      // this only catches a frame in flight across a vault switch.
      if ('vaultId' in event && event.vaultId && event.vaultId !== vaultId) return

      switch (event.kind) {
        case 'changes_available':
          schedulePass()
          return
        case 'crdt_updated':
          scheduleBodyPull(event.noteId)
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
 * Run one full pass, at most one per window.
 *
 * `sync()` and `OutboxDrain.drain()` each coalesce, but `EditorSession.flush`
 * re-runs its own token refresh per caller, so N concurrent passes were N
 * `/auth/refresh` posts. One trailing pass per burst removes that fan-out.
 */
function schedulePass(): void {
  if (passTimer) return
  passTimer = setTimeout(() => {
    passTimer = null
    const vaultId = activeVaultId
    if (vaultId) void requestVaultSync(vaultId, 'socket')
  }, COALESCE_MS)
}

function scheduleBodyPull(noteId: string): void {
  pendingNoteIds.add(noteId)
  if (bodyTimer) return
  bodyTimer = setTimeout(() => {
    bodyTimer = null
    const noteIds = [...pendingNoteIds]
    pendingNoteIds.clear()
    const vaultId = activeVaultId
    if (vaultId && noteIds.length > 0) void pullBodies(vaultId, noteIds)
  }, COALESCE_MS)
}

/**
 * Fetch the bodies, then feed them to the editor for whichever notes are open.
 *
 * Goes through `pullBodiesForNotes` rather than `getStore()` plus
 * `pullBodiesFor`. Both wrap themselves in `exclusive()`, but `getStore()`
 * calls `prepare()` outside it, and `prepare()` reassigns the vault key the
 * running pass is still reading through a live getter.
 */
async function pullBodies(vaultId: string, noteIds: string[]): Promise<void> {
  try {
    await getSyncEngine(vaultId).pullBodiesForNotes(noteIds)
    // The doc manager caches docs for the process lifetime, so a pull that
    // lands new server rows is invisible on screen until this runs.
    await refreshOpenDocsFor(vaultId, noteIds)
  } catch (err) {
    log.warn('Socket-driven body pull failed', {
      notes: noteIds.length,
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
  clearTimers()
  socket?.stop()
}

/**
 * Tear the socket down for good, dropping the manager itself.
 *
 * The distinction from `stopSyncSocket` is the LATCH. 4004 and 4009 are
 * verdicts about an install and must survive a background/foreground cycle, so
 * `stop()` keeps them. They must NOT survive a sign-out, or the next account on
 * this phone inherits a socket that refuses to connect. The vault shell
 * unmounting is the one event that means "different session", so it is the one
 * event that discards the instance.
 */
export function shutdownSyncSocket(): void {
  stopSyncSocket()
  socket = null
  activeVaultId = null
}

function clearTimers(): void {
  if (bodyTimer) {
    clearTimeout(bodyTimer)
    bodyTimer = null
  }
  if (passTimer) {
    clearTimeout(passTimer)
    passTimer = null
  }
  pendingNoteIds.clear()
}
