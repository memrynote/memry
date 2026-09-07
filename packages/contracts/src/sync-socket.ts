import { z } from 'zod'

/**
 * The `GET /sync/ws` protocol, in one place.
 *
 * Both shells talk to the same Durable Object, and until now each carried its
 * own copy of the message names. A name added on the server and typo'd on one
 * client fails silently, because an unrecognised frame is dropped by design.
 *
 * Auth is handshake headers only, never a query param or a subprotocol.
 * `Authorization: Bearer <accessToken>`, `X-App-Version: <semver>` (mandatory,
 * the server answers 426 without it) and `X-Memry-Vault-Id: <uuid>` (the
 * server filters every broadcast by the socket's attached vault, so a socket
 * without it connects and then hears nothing).
 */

/** Every message name the server can put on a socket today. */
export const SYNC_SOCKET_MESSAGE_TYPES = [
  'changes_available',
  'crdt_updated',
  'calendar_changes_available',
  'heartbeat',
  'auth_ok',
  'error',
  'linking_request',
  'linking_approved'
] as const

export type SyncSocketMessageType = (typeof SYNC_SOCKET_MESSAGE_TYPES)[number]

/**
 * The keepalive frame, and it must be exactly this string.
 *
 * The Durable Object registers `new WebSocketRequestResponsePair('ping',
 * 'pong')`, so Cloudflare answers this one payload without waking the DO or
 * spending the socket's inbound rate-limit budget. Any other keepalive text is
 * a real message that costs a wake on every beat.
 */
export const SYNC_SOCKET_PING = 'ping'
export const SYNC_SOCKET_PONG = 'pong'

/** Close codes the server uses. 4004 and 4009 are terminal for the session. */
export const SYNC_SOCKET_CLOSE = {
  replaced: 4001,
  tokenExpired: 4003,
  deviceRevoked: 4004,
  rateLimited: 4008,
  versionIncompatible: 4009
} as const

const EnvelopeSchema = z.object({
  // A STRING, not an enum over the names above. A newer server must be able to
  // add a message type without every older client treating the frame as
  // corrupt; unknown names parse and are then ignored by the caller.
  type: z.string().min(1),
  payload: z.record(z.string(), z.unknown()).optional()
})

const ChangesAvailableSchema = z.object({
  cursor: z.number().optional(),
  vaultId: z.string().optional()
})
const CrdtUpdatedSchema = z.object({
  vaultId: z.string().optional(),
  noteId: z.string().min(1)
})
const AuthOkSchema = z.object({ exp: z.number().optional() })
const ErrorSchema = z.object({ code: z.string().optional(), message: z.string().optional() })

/**
 * A frame narrowed to what a client can act on.
 *
 * `ignored` is a real outcome rather than an error: it covers the keepalive
 * answer, the message types this client has no handler for, and a known type
 * whose payload does not carry what it needs. All three mean "do nothing", and
 * collapsing them into one variant is what keeps an unrecognised frame from
 * ever reaching a throw.
 */
export type SyncSocketEvent =
  | { kind: 'changes_available'; vaultId?: string; cursor?: number }
  | { kind: 'crdt_updated'; vaultId?: string; noteId: string }
  | { kind: 'auth_ok'; exp?: number }
  | { kind: 'error'; code?: string; message?: string }
  | { kind: 'ignored'; type: string }

/** The client→server frame that re-authenticates a live socket in place. */
export function syncSocketAuthFrame(token: string): string {
  return JSON.stringify({ type: 'auth', payload: { token } })
}

/**
 * Parse one inbound text frame. `null` means it was not a message envelope at
 * all (bad JSON, or no `type`) — the only case worth logging.
 */
export function parseSyncSocketFrame(raw: string): SyncSocketEvent | null {
  if (raw === SYNC_SOCKET_PONG) return { kind: 'ignored', type: SYNC_SOCKET_PONG }

  let json: unknown
  try {
    json = JSON.parse(raw)
  } catch {
    return null
  }

  const envelope = EnvelopeSchema.safeParse(json)
  if (!envelope.success) return null

  const { type, payload } = envelope.data
  const ignored = { kind: 'ignored', type } as const

  switch (type) {
    case 'changes_available': {
      const parsed = ChangesAvailableSchema.safeParse(payload ?? {})
      return parsed.success ? { kind: 'changes_available', ...parsed.data } : ignored
    }
    case 'crdt_updated': {
      const parsed = CrdtUpdatedSchema.safeParse(payload ?? {})
      return parsed.success ? { kind: 'crdt_updated', ...parsed.data } : ignored
    }
    case 'auth_ok': {
      const parsed = AuthOkSchema.safeParse(payload ?? {})
      return parsed.success ? { kind: 'auth_ok', ...parsed.data } : ignored
    }
    case 'error': {
      const parsed = ErrorSchema.safeParse(payload ?? {})
      return parsed.success ? { kind: 'error', ...parsed.data } : ignored
    }
    default:
      return ignored
  }
}
