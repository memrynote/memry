import { describe, expect, it } from 'vitest'
import {
  parseSyncSocketFrame,
  syncSocketAuthFrame,
  SYNC_SOCKET_CLOSE,
  SYNC_SOCKET_ITEMS_HEADER,
  SYNC_SOCKET_MESSAGE_TYPES,
  SYNC_SOCKET_PING,
  SYNC_SOCKET_PONG
} from './sync-socket'

const frame = (type: string, payload?: Record<string, unknown>): string =>
  JSON.stringify(payload === undefined ? { type } : { type, payload })

describe('parseSyncSocketFrame', () => {
  it('narrows the four types a client acts on', () => {
    expect(parseSyncSocketFrame(frame('changes_available', { cursor: 42, vaultId: 'v1' }))).toEqual(
      {
        kind: 'changes_available',
        cursor: 42,
        vaultId: 'v1'
      }
    )
    expect(parseSyncSocketFrame(frame('crdt_updated', { vaultId: 'v1', noteId: 'n1' }))).toEqual({
      kind: 'crdt_updated',
      vaultId: 'v1',
      noteId: 'n1'
    })
    expect(parseSyncSocketFrame(frame('auth_ok', { exp: 99 }))).toEqual({
      kind: 'auth_ok',
      exp: 99
    })
    expect(parseSyncSocketFrame(frame('error', { code: 'X', message: 'y' }))).toEqual({
      kind: 'error',
      code: 'X',
      message: 'y'
    })
  })

  // #2291: desktop parses every frame through this helper, so the three types
  // whose payload it acts on must be narrowed, not collapsed to `ignored`.
  it('narrows the exact payloads the server emits for calendar and linking frames', () => {
    // UserSyncState /broadcast wraps the webhook body's sourceId into payload.
    expect(
      parseSyncSocketFrame(frame('calendar_changes_available', { sourceId: 'google:primary' }))
    ).toEqual({ kind: 'calendar_changes_available', sourceId: 'google:primary' })
    // /notify-linking forwards the route's payload verbatim.
    expect(
      parseSyncSocketFrame(
        frame('linking_request', {
          sessionId: 's1',
          newDeviceName: 'Laptop',
          newDevicePlatform: 'macos'
        })
      )
    ).toEqual({
      kind: 'linking_request',
      sessionId: 's1',
      newDeviceName: 'Laptop',
      newDevicePlatform: 'macos'
    })
    expect(parseSyncSocketFrame(frame('linking_approved', { sessionId: 's1' }))).toEqual({
      kind: 'linking_approved',
      sessionId: 's1'
    })
  })

  it('strips unknown payload keys instead of rejecting the frame (#2291)', () => {
    expect(
      parseSyncSocketFrame(frame('linking_approved', { sessionId: 's1', addedLater: true }))
    ).toEqual({ kind: 'linking_approved', sessionId: 's1' })
  })

  it('ignores calendar and linking frames missing a required field (#2291)', () => {
    expect(parseSyncSocketFrame(frame('calendar_changes_available', {}))).toEqual({
      kind: 'ignored',
      type: 'calendar_changes_available'
    })
    expect(parseSyncSocketFrame(frame('linking_request', { sessionId: 's1' }))).toEqual({
      kind: 'ignored',
      type: 'linking_request'
    })
    expect(parseSyncSocketFrame(frame('linking_approved'))).toEqual({
      kind: 'ignored',
      type: 'linking_approved'
    })
  })

  it('ignores the types this client has no handler for', () => {
    expect(parseSyncSocketFrame(frame('heartbeat'))).toEqual({ kind: 'ignored', type: 'heartbeat' })
  })

  it('ignores a type it has never heard of instead of failing the frame', () => {
    // The compatibility rule the whole schema exists for: a server that starts
    // sending something new must not break a client that shipped before it.
    expect(parseSyncSocketFrame(frame('quantum_entangled', { anything: true }))).toEqual({
      kind: 'ignored',
      type: 'quantum_entangled'
    })
  })

  it('ignores a known type whose payload is missing what it needs', () => {
    // `crdt_updated` without a note id names no work, so it is nothing to do
    // rather than an error to report.
    expect(parseSyncSocketFrame(frame('crdt_updated', { vaultId: 'v1' }))).toEqual({
      kind: 'ignored',
      type: 'crdt_updated'
    })
  })

  // #2420: the server names the cursor its CRDT write reserved.
  it('carries the cursor of a crdt_updated frame', () => {
    expect(
      parseSyncSocketFrame(frame('crdt_updated', { vaultId: 'v1', noteId: 'n1', cursor: 43 }))
    ).toEqual({ kind: 'crdt_updated', vaultId: 'v1', noteId: 'n1', cursor: 43 })
  })

  // #2420: a duplicate-only retry reserves nothing, and an old server never sends one.
  // #2420: a bad cursor must not cost the per-note pull the frame asks for.
  it('keeps a crdt_updated frame whose cursor is malformed, without the cursor', () => {
    for (const cursor of [-1, 1.5, '43', null]) {
      const event = parseSyncSocketFrame(frame('crdt_updated', { noteId: 'n1', cursor }))
      expect(event).toMatchObject({ kind: 'crdt_updated', noteId: 'n1' })
      expect(event).toHaveProperty('cursor', undefined)
    }
  })

  it('parses a crdt_updated frame without a cursor, as an old server sends it', () => {
    const event = parseSyncSocketFrame(frame('crdt_updated', { vaultId: 'v1', noteId: 'n1' }))
    expect(event).toEqual({ kind: 'crdt_updated', vaultId: 'v1', noteId: 'n1' })
    expect(event).not.toHaveProperty('cursor')
    expect(parseSyncSocketFrame(frame('crdt_updated', { noteId: 'n1' }))).toEqual({
      kind: 'crdt_updated',
      noteId: 'n1'
    })
  })

  it('tolerates a payload-less frame', () => {
    expect(parseSyncSocketFrame(frame('changes_available'))).toEqual({ kind: 'changes_available' })
  })

  it('swallows the keepalive answer', () => {
    expect(parseSyncSocketFrame(SYNC_SOCKET_PONG)).toEqual({ kind: 'ignored', type: 'pong' })
  })

  it('returns null only when the frame is not an envelope', () => {
    expect(parseSyncSocketFrame('not json')).toBeNull()
    expect(parseSyncSocketFrame('{"payload":{}}')).toBeNull()
    expect(parseSyncSocketFrame('{"type":""}')).toBeNull()
    expect(parseSyncSocketFrame('[]')).toBeNull()
  })
})

describe('protocol constants', () => {
  it('keeps the keepalive exactly the string Cloudflare auto-answers', () => {
    // A different payload wakes the Durable Object on every beat and spends
    // the socket's inbound rate-limit budget.
    expect(SYNC_SOCKET_PING).toBe('ping')
    expect(SYNC_SOCKET_PONG).toBe('pong')
  })

  it('matches the close codes the Durable Object sends', () => {
    expect(SYNC_SOCKET_CLOSE).toEqual({
      replaced: 4001,
      tokenExpired: 4003,
      deviceRevoked: 4004,
      rateLimited: 4008,
      versionIncompatible: 4009
    })
  })

  it('lists every name the server broadcasts', () => {
    expect(SYNC_SOCKET_MESSAGE_TYPES).toContain('changes_available')
    expect(SYNC_SOCKET_MESSAGE_TYPES).toContain('crdt_updated')
  })

  it('builds the in-place re-auth frame', () => {
    expect(JSON.parse(syncSocketAuthFrame('jwt'))).toEqual({
      type: 'auth',
      payload: { token: 'jwt' }
    })
  })
})

// #2300: socket items ride `changes_available` only for an opted-in socket.
describe('changes_available socket items', () => {
  const item = {
    id: 't1',
    type: 'task',
    operation: 'update',
    cryptoVersion: 1,
    signature: 'sig',
    signerDeviceId: 'device-a',
    clock: { 'device-a': 2 },
    blob: { encryptedKey: 'k', keyNonce: 'kn', encryptedData: 'd', dataNonce: 'dn' }
  }

  it('keeps valid items and the commit time next to the wake', () => {
    expect(
      parseSyncSocketFrame(
        frame('changes_available', { cursor: 9, vaultId: 'v1', committedAtMs: 1000, items: [item] })
      )
    ).toEqual({
      kind: 'changes_available',
      cursor: 9,
      vaultId: 'v1',
      committedAtMs: 1000,
      items: [item]
    })
  })

  it('drops invalid elements and keeps the valid ones', () => {
    const parsed = parseSyncSocketFrame(
      frame('changes_available', {
        cursor: 9,
        items: [{ id: 'x', type: 'not_a_type' }, 'garbage', item]
      })
    )
    expect(parsed).toEqual({ kind: 'changes_available', cursor: 9, items: [item] })
  })

  // #2300 restack: a frame is never a body feed (#2297) nor a purged-tombstone
  // channel (#2302/#2408). A note_body element and an unsigned marker are not
  // record items, and a purgedTombstones sibling never reaches the client.
  it('carries no note body and no purged tombstone', () => {
    const marker = { id: 't1', type: 'task', deletedAt: 5, clock: { d: 2 }, serverCursor: 8 }
    const parsed = parseSyncSocketFrame(
      frame('changes_available', {
        cursor: 9,
        items: [{ ...item, type: 'note_body' }, marker, item],
        purgedTombstones: [marker]
      })
    )
    expect(parsed).toEqual({ kind: 'changes_available', cursor: 9, items: [item] })
  })

  it('still parses as a wake when items or committedAtMs are malformed', () => {
    expect(
      parseSyncSocketFrame(
        frame('changes_available', { cursor: 9, items: 'garbage', committedAtMs: 'soon' })
      )
    ).toEqual({ kind: 'changes_available', cursor: 9 })
    expect(
      parseSyncSocketFrame(frame('changes_available', { cursor: 9, items: [{ id: 1 }] }))
    ).toEqual({ kind: 'changes_available', cursor: 9 })
  })

  it('names the handshake opt-in header', () => {
    expect(SYNC_SOCKET_ITEMS_HEADER).toBe('X-Memry-Socket-Items')
  })
})
