import { z } from 'zod'

import { RecordPullItemResponseSchema, type RecordPullItemResponse } from './sync-api'

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
 *
 * Socket items (#2300, protocol 09 §9.13) are opt-in per socket:
 * `X-Memry-Socket-Items: 1` plus `X-Memry-Sync-Types`, resolved exactly as on
 * HTTP. A socket that sends neither receives hint-only frames.
 */

/** Handshake header that opts a socket in to `changes_available` items. */
export const SYNC_SOCKET_ITEMS_HEADER = 'X-Memry-Socket-Items'

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

// `items` and `committedAtMs` fall back to absent instead of failing the
// payload: a malformed item list must never turn the wake into `ignored`.
const ChangesAvailableSchema = z.object({
  cursor: z.number().optional(),
  vaultId: z.string().optional(),
  committedAtMs: z.number().int().min(0).optional().catch(undefined),
  items: z.array(z.unknown()).optional().catch(undefined)
})

/** Per element, like a `/sync/pull` body (protocol 05 §5.14): bad elements are dropped. */
function parseSocketItems(raw: readonly unknown[] | undefined): RecordPullItemResponse[] {
  const items: RecordPullItemResponse[] = []
  for (const element of raw ?? []) {
    const parsed = RecordPullItemResponseSchema.safeParse(element)
    if (parsed.success) items.push(parsed.data)
  }
  return items
}
const CrdtUpdatedSchema = z.object({
  vaultId: z.string().optional(),
  noteId: z.string().min(1),
  // #2420: the highest server_cursor the write reserved, omitted when it stored
  // nothing new. Never a pull cursor (protocol 09 §9.11). A malformed value is
  // dropped, never the frame: the frame still names a note body to pull.
  cursor: z.number().int().nonnegative().optional().catch(undefined)
})
const CalendarChangesAvailableSchema = z.object({ sourceId: z.string().min(1) })
const LinkingRequestSchema = z.object({
  sessionId: z.string(),
  newDeviceName: z.string(),
  newDevicePlatform: z.string()
})
const LinkingApprovedSchema = z.object({ sessionId: z.string() })
const AuthOkSchema = z.object({ exp: z.number().optional() })
const ErrorSchema = z.object({ code: z.string().optional(), message: z.string().optional() })

/**
 * A frame narrowed to what a client can act on.
 *
 * Payload schemas strip unknown keys rather than rejecting them, so a server
 * that adds a payload field does not turn a known frame into `ignored`.
 *
 * `ignored` is a real outcome rather than an error: it covers the keepalive
 * answer, the message types this client has no handler for, and a known type
 * whose payload does not carry what it needs. All three mean "do nothing", and
 * collapsing them into one variant is what keeps an unrecognised frame from
 * ever reaching a throw.
 */
export type SyncSocketEvent =
  | {
      kind: 'changes_available'
      vaultId?: string
      cursor?: number
      /** Server epoch ms of the commit that produced `items` (#2280 latency trace). */
      committedAtMs?: number
      /**
       * `/sync/pull` items of the push that caused this wake, present only on an
       * opted-in socket. Advisory: they never move the cursor (§9.13).
       */
      items?: RecordPullItemResponse[]
    }
  | { kind: 'crdt_updated'; vaultId?: string; noteId: string; cursor?: number }
  | { kind: 'calendar_changes_available'; sourceId: string }
  | {
      kind: 'linking_request'
      sessionId: string
      newDeviceName: string
      newDevicePlatform: string
    }
  | { kind: 'linking_approved'; sessionId: string }
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
      if (!parsed.success) return ignored
      const { items: rawItems, committedAtMs, ...hint } = parsed.data
      const items = parseSocketItems(rawItems)
      return {
        kind: 'changes_available',
        ...hint,
        ...(committedAtMs !== undefined ? { committedAtMs } : {}),
        ...(items.length > 0 ? { items } : {})
      }
    }
    case 'crdt_updated': {
      const parsed = CrdtUpdatedSchema.safeParse(payload ?? {})
      return parsed.success ? { kind: 'crdt_updated', ...parsed.data } : ignored
    }
    case 'calendar_changes_available': {
      const parsed = CalendarChangesAvailableSchema.safeParse(payload ?? {})
      return parsed.success ? { kind: 'calendar_changes_available', ...parsed.data } : ignored
    }
    case 'linking_request': {
      const parsed = LinkingRequestSchema.safeParse(payload ?? {})
      return parsed.success ? { kind: 'linking_request', ...parsed.data } : ignored
    }
    case 'linking_approved': {
      const parsed = LinkingApprovedSchema.safeParse(payload ?? {})
      return parsed.success ? { kind: 'linking_approved', ...parsed.data } : ignored
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
