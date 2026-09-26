import { describe, expect, it } from 'vitest'

import { LEGACY_RECORD_SYNC_ITEM_TYPES } from '@memry/contracts/sync-api'
import type { RecordPullItemResponse } from '@memry/contracts/sync-api'

import {
  DEFAULT_SOCKET_ITEMS_MAX_BYTES,
  SocketFrames,
  selectSocketItems,
  socketItemTypesFromHandshake,
  socketItemsMaxBytes
} from './socket-items'

const item = (id: string, type: RecordPullItemResponse['type']): RecordPullItemResponse => ({
  id,
  type,
  operation: 'update',
  cryptoVersion: 1,
  signature: 'sig',
  signerDeviceId: 'device-a',
  clock: { 'device-a': 1 },
  blob: { encryptedKey: 'k', keyNonce: 'kn', encryptedData: 'd', dataNonce: 'dn' }
})

// #2300
describe('socketItemsMaxBytes', () => {
  it('defaults to 64 KiB when unset or unparseable', () => {
    expect(DEFAULT_SOCKET_ITEMS_MAX_BYTES).toBe(64 * 1024)
    expect(socketItemsMaxBytes({})).toBe(64 * 1024)
    expect(socketItemsMaxBytes({ SYNC_SOCKET_ITEMS_MAX_BYTES: 'lots' })).toBe(64 * 1024)
  })

  it('"0" disables items (the kill switch)', () => {
    expect(socketItemsMaxBytes({ SYNC_SOCKET_ITEMS_MAX_BYTES: '0' })).toBe(0)
  })

  it('can lower the budget but never raise it past 64 KiB', () => {
    expect(socketItemsMaxBytes({ SYNC_SOCKET_ITEMS_MAX_BYTES: '1024' })).toBe(1024)
    expect(socketItemsMaxBytes({ SYNC_SOCKET_ITEMS_MAX_BYTES: '10000000' })).toBe(64 * 1024)
  })
})

// #2300
describe('selectSocketItems', () => {
  const items = [item('t1', 'task'), item('p1', 'project')]

  it('keeps the whole wave when it fits the budget', () => {
    expect(selectSocketItems(items, 64 * 1024)).toEqual(items)
  })

  it('sends nothing, never a truncated list, when the wave is over budget', () => {
    const size = new TextEncoder().encode(JSON.stringify(items)).byteLength
    expect(selectSocketItems(items, size)).toEqual(items)
    expect(selectSocketItems(items, size - 1)).toBeUndefined()
  })

  it('sends nothing when disabled or when nothing committed', () => {
    expect(selectSocketItems(items, 0)).toBeUndefined()
    expect(selectSocketItems([], 64 * 1024)).toBeUndefined()
  })
})

// #2300
describe('socketItemTypesFromHandshake', () => {
  it('is undefined without the opt-in header', () => {
    expect(socketItemTypesFromHandshake(new Headers())).toBeUndefined()
    expect(
      socketItemTypesFromHandshake(new Headers({ 'X-Memry-Sync-Types': 'task' }))
    ).toBeUndefined()
    expect(
      socketItemTypesFromHandshake(new Headers({ 'X-Memry-Socket-Items': 'yes' }))
    ).toBeUndefined()
  })

  // The feed-only tokens (note_body, and purged_tombstones from #2302) are
  // never record types: no body and no purged-tombstone marker is a socket item.
  it('resolves the declared types exactly like HTTP', () => {
    expect(
      socketItemTypesFromHandshake(
        new Headers({
          'X-Memry-Socket-Items': '1',
          'X-Memry-Sync-Types': 'task,note_body,purged_tombstones,bogus'
        })
      )
    ).toEqual(['task'])
  })

  it('an opted-in socket with no types header gets the legacy list', () => {
    expect(socketItemTypesFromHandshake(new Headers({ 'X-Memry-Socket-Items': '1' }))).toEqual([
      ...LEGACY_RECORD_SYNC_ITEM_TYPES
    ])
  })
})

// #2300
describe('SocketFrames', () => {
  const hint = { type: 'changes_available', payload: { cursor: 9, vaultId: 'v1' } }
  const legacyFrame = JSON.stringify(hint)

  it('a socket that did not opt in gets the exact pre-#2300 frame', () => {
    const frames = new SocketFrames(hint, [item('t1', 'task')], 1000)
    expect(frames.forSocket(undefined)).toBe(legacyFrame)
  })

  it('an opted-in socket gets only its declared types', () => {
    const frames = new SocketFrames(hint, [item('t1', 'task'), item('p1', 'project')], 1000)
    expect(JSON.parse(frames.forSocket(['task']))).toEqual({
      type: 'changes_available',
      payload: { cursor: 9, vaultId: 'v1', committedAtMs: 1000, items: [item('t1', 'task')] }
    })
  })

  it('a filter that leaves zero items sends the hint-only frame', () => {
    const frames = new SocketFrames(hint, [item('p1', 'project')], 1000)
    expect(frames.forSocket(['task'])).toBe(legacyFrame)
  })

  it('a broadcast without items sends the hint-only frame to every socket', () => {
    const frames = new SocketFrames(hint, undefined, undefined)
    expect(frames.forSocket(['task'])).toBe(legacyFrame)
  })

  it('never attaches items to a frame that is not changes_available', () => {
    const crdt = { type: 'crdt_updated', payload: { noteId: 'n1', cursor: 12 } }
    const frames = new SocketFrames(crdt, [item('t1', 'task')], 1000)
    expect(frames.forSocket(['task'])).toBe(JSON.stringify(crdt))
  })
})
