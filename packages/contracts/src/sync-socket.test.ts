import { describe, expect, it } from 'vitest'
import {
  parseSyncSocketFrame,
  syncSocketAuthFrame,
  SYNC_SOCKET_CLOSE,
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

  it('ignores the types this client has no handler for', () => {
    for (const type of ['calendar_changes_available', 'linking_request', 'linking_approved']) {
      expect(parseSyncSocketFrame(frame(type, {}))).toEqual({ kind: 'ignored', type })
    }
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
