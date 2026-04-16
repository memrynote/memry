/**
 * IPC Sync Barrel Tests
 *
 * ipc-sync.ts is a composition barrel: it re-exports every sync-related IPC
 * module and merges their channel maps into SYNC_CHANNELS / SYNC_EVENTS.
 * These tests lock the merged shape so new sub-modules can't silently drop
 * channels or clobber existing keys.
 */

import { describe, it, expect } from 'vitest'

import {
  SYNC_CHANNELS,
  SYNC_EVENTS,
  AUTH_CHANNELS,
  CRYPTO_CHANNELS,
  SYNC_OP_CHANNELS,
  DEVICE_CHANNELS,
  ATTACHMENT_CHANNELS,
  CRDT_CHANNELS,
  EVENT_CHANNELS,
  CRDT_EVENTS
} from './ipc-sync'

describe('SYNC_CHANNELS composition', () => {
  it('includes every AUTH_CHANNELS key', () => {
    for (const [key, value] of Object.entries(AUTH_CHANNELS)) {
      expect(SYNC_CHANNELS).toHaveProperty(key, value)
    }
  })

  it('includes every CRYPTO_CHANNELS key', () => {
    for (const [key, value] of Object.entries(CRYPTO_CHANNELS)) {
      expect(SYNC_CHANNELS).toHaveProperty(key, value)
    }
  })

  it('includes every SYNC_OP_CHANNELS key', () => {
    for (const [key, value] of Object.entries(SYNC_OP_CHANNELS)) {
      expect(SYNC_CHANNELS).toHaveProperty(key, value)
    }
  })

  it('includes every DEVICE_CHANNELS key', () => {
    for (const [key, value] of Object.entries(DEVICE_CHANNELS)) {
      expect(SYNC_CHANNELS).toHaveProperty(key, value)
    }
  })

  it('includes every ATTACHMENT_CHANNELS key', () => {
    for (const [key, value] of Object.entries(ATTACHMENT_CHANNELS)) {
      expect(SYNC_CHANNELS).toHaveProperty(key, value)
    }
  })

  it('includes every CRDT_CHANNELS key', () => {
    for (const [key, value] of Object.entries(CRDT_CHANNELS)) {
      expect(SYNC_CHANNELS).toHaveProperty(key, value)
    }
  })

  it('has channel values that are unique (no key clobbering)', () => {
    const values = Object.values(SYNC_CHANNELS)
    expect(new Set(values).size).toBe(values.length)
  })

  it('key count equals sum of source maps', () => {
    const total =
      Object.keys(AUTH_CHANNELS).length +
      Object.keys(CRYPTO_CHANNELS).length +
      Object.keys(SYNC_OP_CHANNELS).length +
      Object.keys(DEVICE_CHANNELS).length +
      Object.keys(ATTACHMENT_CHANNELS).length +
      Object.keys(CRDT_CHANNELS).length
    expect(Object.keys(SYNC_CHANNELS)).toHaveLength(total)
  })
})

describe('SYNC_EVENTS composition', () => {
  it('includes every EVENT_CHANNELS key', () => {
    for (const [key, value] of Object.entries(EVENT_CHANNELS)) {
      expect(SYNC_EVENTS).toHaveProperty(key, value)
    }
  })

  it('includes every CRDT_EVENTS key', () => {
    for (const [key, value] of Object.entries(CRDT_EVENTS)) {
      expect(SYNC_EVENTS).toHaveProperty(key, value)
    }
  })

  it('has event values that are unique', () => {
    const values = Object.values(SYNC_EVENTS)
    expect(new Set(values).size).toBe(values.length)
  })

  it('key count equals sum of source maps', () => {
    const total = Object.keys(EVENT_CHANNELS).length + Object.keys(CRDT_EVENTS).length
    expect(Object.keys(SYNC_EVENTS)).toHaveLength(total)
  })
})
