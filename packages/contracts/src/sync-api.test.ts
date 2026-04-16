/**
 * Sync API Contract Tests
 *
 * Zod schema validation coverage for sync push/pull envelopes, manifest, and
 * conflict-response shapes plus device/cursor metadata.
 */

import { describe, it, expect } from 'vitest'

import {
  ChangesResponseSchema,
  ConflictResponseSchema,
  CursorPositionSchema,
  DeviceKeySchema,
  DeviceKeysResponseSchema,
  DeviceSyncStateSchema,
  EncryptedItemPayloadSchema,
  FieldClocksSchema,
  OFFLINE_CLOCK_DEVICE_ID,
  PullItemResponseSchema,
  PullRequestSchema,
  PullResponseSchema,
  PushItemSchema,
  PushRequestSchema,
  PushResponseSchema,
  RecordChangesResponseSchema,
  RecordPullItemResponseSchema,
  RecordPullResponseSchema,
  RecordPushItemSchema,
  RecordPushRequestSchema,
  RecordSyncItemRefSchema,
  RecordSyncManifestSchema,
  SignatureMetadataSchema,
  SyncItemRefSchema,
  SyncItemSchema,
  SyncManifestSchema,
  SyncQueueItemSchema,
  SyncStatusSchema,
  VectorClockSchema,
  SYNC_ITEM_TYPES,
  RECORD_SYNC_ITEM_TYPES,
  RECORD_CLOCK_REQUIRED_ITEM_TYPES,
  CRDT_SYNC_ITEM_TYPES,
  SYNC_OPERATIONS,
  ENCRYPTABLE_ITEM_TYPES
} from './sync-api'

const VALID_UUID = '11111111-1111-4111-8111-111111111111'

const validEncryptedPayload = () => ({
  encryptedKey: 'ek',
  keyNonce: 'kn',
  encryptedData: 'ed',
  dataNonce: 'dn'
})

const validPushItem = (overrides: Record<string, unknown> = {}) => ({
  id: 'item-1',
  type: 'task' as const,
  operation: 'create' as const,
  encryptedKey: 'ek',
  keyNonce: 'kn',
  encryptedData: 'ed',
  dataNonce: 'dn',
  signature: 'sig',
  signerDeviceId: 'device-1',
  ...overrides
})

describe('constants', () => {
  it('exposes expected sync item types', () => {
    expect(SYNC_ITEM_TYPES).toContain('note')
    expect(SYNC_ITEM_TYPES).toContain('calendar_external_event')
  })

  it('record types exclude attachment', () => {
    expect(RECORD_SYNC_ITEM_TYPES).not.toContain('attachment')
  })

  it('record-clock-required excludes settings', () => {
    expect(RECORD_CLOCK_REQUIRED_ITEM_TYPES).not.toContain('settings')
  })

  it('CRDT sync list is note-only', () => {
    expect(CRDT_SYNC_ITEM_TYPES).toEqual(['note'])
  })

  it('sync operations are create/update/delete', () => {
    expect(SYNC_OPERATIONS).toEqual(['create', 'update', 'delete'])
  })

  it('encryptable list excludes attachment', () => {
    expect(ENCRYPTABLE_ITEM_TYPES).not.toContain('attachment')
  })

  it('offline device id is stable', () => {
    expect(OFFLINE_CLOCK_DEVICE_ID).toBe('_offline')
  })
})

describe('VectorClockSchema', () => {
  it('accepts empty map', () => {
    expect(VectorClockSchema.safeParse({}).success).toBe(true)
  })

  it('accepts device-id keyed ticks', () => {
    expect(VectorClockSchema.safeParse({ 'device-a': 1, _offline: 0 }).success).toBe(true)
  })

  it('rejects negative ticks', () => {
    const result = VectorClockSchema.safeParse({ 'device-a': -1 })
    expect(result.success).toBe(false)
  })

  it('rejects non-integer ticks', () => {
    const result = VectorClockSchema.safeParse({ 'device-a': 1.5 })
    expect(result.success).toBe(false)
  })
})

describe('FieldClocksSchema', () => {
  it('accepts per-field vector clocks', () => {
    const result = FieldClocksSchema.safeParse({
      title: { 'device-a': 1 },
      description: { 'device-a': 2, 'device-b': 1 }
    })
    expect(result.success).toBe(true)
  })

  it('rejects non-vector-clock value', () => {
    const result = FieldClocksSchema.safeParse({ title: 'not-a-clock' })
    expect(result.success).toBe(false)
  })
})

describe('EncryptedItemPayloadSchema', () => {
  it('accepts minimal payload', () => {
    expect(EncryptedItemPayloadSchema.safeParse(validEncryptedPayload()).success).toBe(true)
  })

  it('rejects empty encryptedKey', () => {
    const result = EncryptedItemPayloadSchema.safeParse({
      ...validEncryptedPayload(),
      encryptedKey: ''
    })
    expect(result.success).toBe(false)
    if (!result.success) {
      expect(result.error.issues[0].path).toContain('encryptedKey')
    }
  })

  it('rejects missing dataNonce', () => {
    const { dataNonce: _dataNonce, ...rest } = validEncryptedPayload()
    const result = EncryptedItemPayloadSchema.safeParse(rest)
    expect(result.success).toBe(false)
  })
})

describe('SyncItemSchema', () => {
  const base = {
    id: VALID_UUID,
    userId: 'user-1',
    itemType: 'task' as const,
    itemId: 'task-1',
    blobKey: 'blob/key',
    sizeBytes: 128,
    contentHash: 'hash',
    serverCursor: 5,
    signerDeviceId: 'device-1',
    signature: 'sig',
    createdAt: 1,
    updatedAt: 2
  }

  it('accepts minimal sync item with defaults', () => {
    const result = SyncItemSchema.safeParse(base)
    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data.version).toBe(1)
      expect(result.data.cryptoVersion).toBe(1)
    }
  })

  it('accepts full sync item with clock + stateVector + deletedAt', () => {
    const result = SyncItemSchema.safeParse({
      ...base,
      version: 3,
      cryptoVersion: 2,
      stateVector: 'sv-base64',
      clock: { 'device-1': 3 },
      deletedAt: 999
    })
    expect(result.success).toBe(true)
  })

  it('rejects non-uuid id', () => {
    const result = SyncItemSchema.safeParse({ ...base, id: 'not-uuid' })
    expect(result.success).toBe(false)
    if (!result.success) {
      expect(result.error.issues[0].path).toContain('id')
    }
  })

  it('rejects negative sizeBytes', () => {
    expect(SyncItemSchema.safeParse({ ...base, sizeBytes: -1 }).success).toBe(false)
  })

  it('rejects version below 1', () => {
    expect(SyncItemSchema.safeParse({ ...base, version: 0 }).success).toBe(false)
  })

  it('rejects unknown itemType', () => {
    expect(SyncItemSchema.safeParse({ ...base, itemType: 'widget' }).success).toBe(false)
  })
})

describe('SyncQueueItemSchema', () => {
  const base = {
    id: VALID_UUID,
    type: 'task' as const,
    itemId: 'task-1',
    operation: 'update' as const,
    payload: '{}',
    createdAt: 1
  }

  it('accepts minimal queue item', () => {
    const result = SyncQueueItemSchema.safeParse(base)
    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data.priority).toBe(0)
      expect(result.data.attempts).toBe(0)
    }
  })

  it('accepts full queue item with lastAttempt/errorMessage', () => {
    const result = SyncQueueItemSchema.safeParse({
      ...base,
      priority: 5,
      attempts: 3,
      lastAttempt: 10,
      errorMessage: 'boom'
    })
    expect(result.success).toBe(true)
  })

  it('rejects unknown operation', () => {
    expect(
      SyncQueueItemSchema.safeParse({ ...base, operation: 'patch' }).success
    ).toBe(false)
  })

  it('rejects empty payload', () => {
    expect(SyncQueueItemSchema.safeParse({ ...base, payload: '' }).success).toBe(false)
  })
})

describe('PushItemSchema', () => {
  it('accepts minimal push item', () => {
    expect(PushItemSchema.safeParse(validPushItem()).success).toBe(true)
  })

  it('accepts push item with clock + stateVector + deletedAt', () => {
    const result = PushItemSchema.safeParse(
      validPushItem({
        clock: { 'device-a': 1 },
        stateVector: 'sv',
        deletedAt: 123
      })
    )
    expect(result.success).toBe(true)
  })

  it('rejects missing signature', () => {
    const { signature: _signature, ...rest } = validPushItem()
    expect(PushItemSchema.safeParse(rest).success).toBe(false)
  })

  it('rejects unknown type', () => {
    expect(PushItemSchema.safeParse(validPushItem({ type: 'widget' })).success).toBe(false)
  })
})

describe('PushRequestSchema', () => {
  it('accepts 1..100 items', () => {
    const one = PushRequestSchema.safeParse({ items: [validPushItem()] })
    expect(one.success).toBe(true)

    const hundred = PushRequestSchema.safeParse({
      items: Array.from({ length: 100 }, (_, i) => validPushItem({ id: `item-${i}` }))
    })
    expect(hundred.success).toBe(true)
  })

  it('rejects empty items array', () => {
    expect(PushRequestSchema.safeParse({ items: [] }).success).toBe(false)
  })

  it('rejects over 100 items', () => {
    const items = Array.from({ length: 101 }, (_, i) => validPushItem({ id: `item-${i}` }))
    expect(PushRequestSchema.safeParse({ items }).success).toBe(false)
  })
})

describe('RecordPushItemSchema', () => {
  it('accepts record type with clock when required', () => {
    const result = RecordPushItemSchema.safeParse(
      validPushItem({ type: 'note', clock: { 'device-a': 1 } })
    )
    expect(result.success).toBe(true)
  })

  it('accepts settings without clock (not clock-required)', () => {
    const result = RecordPushItemSchema.safeParse(
      validPushItem({ type: 'settings' })
    )
    expect(result.success).toBe(true)
  })

  it('rejects record type missing required clock', () => {
    const result = RecordPushItemSchema.safeParse(validPushItem({ type: 'task' }))
    expect(result.success).toBe(false)
    if (!result.success) {
      expect(result.error.issues[0].path).toContain('clock')
      expect(result.error.issues[0].message).toMatch(/requires clock metadata/)
    }
  })

  it('rejects attachment type (not in record list)', () => {
    const result = RecordPushItemSchema.safeParse(validPushItem({ type: 'attachment' }))
    expect(result.success).toBe(false)
  })
})

describe('RecordPushRequestSchema', () => {
  it('accepts valid batch', () => {
    const result = RecordPushRequestSchema.safeParse({
      items: [validPushItem({ type: 'note', clock: { a: 1 } })]
    })
    expect(result.success).toBe(true)
  })

  it('rejects empty batch', () => {
    expect(RecordPushRequestSchema.safeParse({ items: [] }).success).toBe(false)
  })
})

describe('PushResponseSchema', () => {
  it('accepts minimal response', () => {
    const result = PushResponseSchema.safeParse({
      accepted: ['id-1'],
      rejected: [],
      serverTime: 1,
      maxCursor: 10
    })
    expect(result.success).toBe(true)
  })

  it('accepts response with rejections', () => {
    const result = PushResponseSchema.safeParse({
      accepted: [],
      rejected: [{ id: 'id-1', reason: 'conflict' }],
      serverTime: 1,
      maxCursor: 10
    })
    expect(result.success).toBe(true)
  })

  it('rejects negative serverTime', () => {
    expect(
      PushResponseSchema.safeParse({
        accepted: [],
        rejected: [],
        serverTime: -1,
        maxCursor: 0
      }).success
    ).toBe(false)
  })
})

describe('PullRequestSchema', () => {
  it('accepts 1..100 item ids', () => {
    expect(PullRequestSchema.safeParse({ itemIds: ['a'] }).success).toBe(true)
    expect(
      PullRequestSchema.safeParse({
        itemIds: Array.from({ length: 100 }, (_, i) => `id-${i}`)
      }).success
    ).toBe(true)
  })

  it('rejects empty itemIds', () => {
    expect(PullRequestSchema.safeParse({ itemIds: [] }).success).toBe(false)
  })

  it('rejects over 100 itemIds', () => {
    expect(
      PullRequestSchema.safeParse({
        itemIds: Array.from({ length: 101 }, (_, i) => `id-${i}`)
      }).success
    ).toBe(false)
  })
})

describe('SyncItemRefSchema', () => {
  it('accepts minimal ref', () => {
    const result = SyncItemRefSchema.safeParse({
      id: 'id-1',
      type: 'task',
      version: 1,
      modifiedAt: 0,
      size: 0
    })
    expect(result.success).toBe(true)
  })

  it('accepts ref with stateVector', () => {
    const result = SyncItemRefSchema.safeParse({
      id: 'id-1',
      type: 'note',
      version: 2,
      modifiedAt: 1,
      size: 5,
      stateVector: 'sv'
    })
    expect(result.success).toBe(true)
  })

  it('rejects version below 1', () => {
    expect(
      SyncItemRefSchema.safeParse({
        id: 'id-1',
        type: 'task',
        version: 0,
        modifiedAt: 0,
        size: 0
      }).success
    ).toBe(false)
  })
})

describe('RecordSyncItemRefSchema', () => {
  it('accepts record-type ref without stateVector', () => {
    const result = RecordSyncItemRefSchema.safeParse({
      id: 'id-1',
      type: 'task',
      version: 1,
      modifiedAt: 0,
      size: 0
    })
    expect(result.success).toBe(true)
  })

  it('rejects attachment type', () => {
    const result = RecordSyncItemRefSchema.safeParse({
      id: 'id-1',
      type: 'attachment',
      version: 1,
      modifiedAt: 0,
      size: 0
    })
    expect(result.success).toBe(false)
  })
})

describe('SyncManifestSchema', () => {
  it('accepts empty manifest', () => {
    expect(SyncManifestSchema.safeParse({ items: [], serverTime: 0 }).success).toBe(true)
  })

  it('accepts manifest with refs', () => {
    const result = SyncManifestSchema.safeParse({
      items: [{ id: 'a', type: 'task', version: 1, modifiedAt: 0, size: 0 }],
      serverTime: 1
    })
    expect(result.success).toBe(true)
  })

  it('rejects bad ref inside items', () => {
    const result = SyncManifestSchema.safeParse({
      items: [{ id: 'a', type: 'task', version: 0, modifiedAt: 0, size: 0 }],
      serverTime: 0
    })
    expect(result.success).toBe(false)
  })
})

describe('RecordSyncManifestSchema', () => {
  it('accepts record manifest', () => {
    const result = RecordSyncManifestSchema.safeParse({
      items: [{ id: 'a', type: 'note', version: 1, modifiedAt: 0, size: 0 }],
      serverTime: 0
    })
    expect(result.success).toBe(true)
  })
})

describe('ChangesResponseSchema', () => {
  it('accepts pagination cursor + hasMore', () => {
    const result = ChangesResponseSchema.safeParse({
      items: [],
      deleted: ['id-gone'],
      hasMore: true,
      nextCursor: 42
    })
    expect(result.success).toBe(true)
  })

  it('rejects non-boolean hasMore', () => {
    const result = ChangesResponseSchema.safeParse({
      items: [],
      deleted: [],
      hasMore: 'yes',
      nextCursor: 0
    })
    expect(result.success).toBe(false)
  })

  it('rejects negative nextCursor', () => {
    const result = ChangesResponseSchema.safeParse({
      items: [],
      deleted: [],
      hasMore: false,
      nextCursor: -1
    })
    expect(result.success).toBe(false)
  })
})

describe('RecordChangesResponseSchema', () => {
  it('accepts record changes', () => {
    expect(
      RecordChangesResponseSchema.safeParse({
        items: [],
        deleted: [],
        hasMore: false,
        nextCursor: 0
      }).success
    ).toBe(true)
  })
})

describe('SyncStatusSchema', () => {
  it('accepts connected status without optional fields', () => {
    expect(
      SyncStatusSchema.safeParse({ connected: true, pendingItems: 0, serverTime: 0 }).success
    ).toBe(true)
  })

  it('accepts lastSyncAt timestamp', () => {
    expect(
      SyncStatusSchema.safeParse({
        connected: false,
        lastSyncAt: 999,
        pendingItems: 2,
        serverTime: 100
      }).success
    ).toBe(true)
  })
})

describe('ConflictResponseSchema', () => {
  it('accepts conflict shape', () => {
    const result = ConflictResponseSchema.safeParse({
      conflicts: [
        {
          id: 'id-1',
          localClock: { 'device-a': 2 },
          serverClock: { 'device-b': 3 },
          serverVersion: validEncryptedPayload()
        }
      ]
    })
    expect(result.success).toBe(true)
  })

  it('rejects missing serverVersion', () => {
    const result = ConflictResponseSchema.safeParse({
      conflicts: [{ id: 'id-1', localClock: {}, serverClock: {} }]
    })
    expect(result.success).toBe(false)
  })
})

describe('DeviceSyncStateSchema', () => {
  it('accepts minimal state', () => {
    expect(
      DeviceSyncStateSchema.safeParse({
        deviceId: 'd',
        lastCursorSeen: 0,
        updatedAt: 0
      }).success
    ).toBe(true)
  })

  it('rejects empty deviceId', () => {
    expect(
      DeviceSyncStateSchema.safeParse({
        deviceId: '',
        lastCursorSeen: 0,
        updatedAt: 0
      }).success
    ).toBe(false)
  })
})

describe('PullItemResponseSchema', () => {
  const base = {
    id: 'id-1',
    type: 'task' as const,
    operation: 'update' as const,
    signature: 'sig',
    signerDeviceId: 'device-1',
    blob: validEncryptedPayload()
  }

  it('accepts minimal pull item', () => {
    expect(PullItemResponseSchema.safeParse(base).success).toBe(true)
  })

  it('accepts pull item with clock + stateVector + cryptoVersion', () => {
    const result = PullItemResponseSchema.safeParse({
      ...base,
      cryptoVersion: 2,
      clock: { 'device-1': 1 },
      stateVector: 'sv',
      deletedAt: 99
    })
    expect(result.success).toBe(true)
  })

  it('rejects missing blob', () => {
    const { blob: _blob, ...rest } = base
    expect(PullItemResponseSchema.safeParse(rest).success).toBe(false)
  })
})

describe('RecordPullItemResponseSchema', () => {
  it('accepts record type', () => {
    const result = RecordPullItemResponseSchema.safeParse({
      id: 'id-1',
      type: 'note',
      operation: 'create',
      signature: 'sig',
      signerDeviceId: 'device-1',
      blob: validEncryptedPayload()
    })
    expect(result.success).toBe(true)
  })

  it('rejects attachment type', () => {
    const result = RecordPullItemResponseSchema.safeParse({
      id: 'id-1',
      type: 'attachment',
      operation: 'create',
      signature: 'sig',
      signerDeviceId: 'device-1',
      blob: validEncryptedPayload()
    })
    expect(result.success).toBe(false)
  })
})

describe('PullResponseSchema', () => {
  it('accepts empty items', () => {
    expect(PullResponseSchema.safeParse({ items: [] }).success).toBe(true)
  })
})

describe('RecordPullResponseSchema', () => {
  it('accepts empty items', () => {
    expect(RecordPullResponseSchema.safeParse({ items: [] }).success).toBe(true)
  })
})

describe('DeviceKeySchema / DeviceKeysResponseSchema', () => {
  it('accepts active device key', () => {
    const result = DeviceKeySchema.safeParse({
      id: 'd1',
      name: 'Laptop',
      platform: 'macos',
      signingPublicKey: 'pk',
      revokedAt: null
    })
    expect(result.success).toBe(true)
  })

  it('accepts revoked device key with timestamp', () => {
    const result = DeviceKeySchema.safeParse({
      id: 'd1',
      name: 'Laptop',
      platform: 'macos',
      signingPublicKey: 'pk',
      revokedAt: 123
    })
    expect(result.success).toBe(true)
  })

  it('rejects missing revokedAt', () => {
    const result = DeviceKeySchema.safeParse({
      id: 'd1',
      name: 'Laptop',
      platform: 'macos',
      signingPublicKey: 'pk'
    })
    expect(result.success).toBe(false)
    if (!result.success) {
      expect(result.error.issues[0].path).toContain('revokedAt')
    }
  })

  it('accepts devices response', () => {
    const result = DeviceKeysResponseSchema.safeParse({
      devices: [
        { id: 'd1', name: 'A', platform: 'macos', signingPublicKey: 'pk', revokedAt: null }
      ]
    })
    expect(result.success).toBe(true)
  })
})

describe('CursorPositionSchema', () => {
  it('accepts minimal cursor', () => {
    expect(
      CursorPositionSchema.safeParse({ cursor: 0, deviceId: 'd', updatedAt: 0 }).success
    ).toBe(true)
  })

  it('rejects negative cursor', () => {
    expect(
      CursorPositionSchema.safeParse({ cursor: -1, deviceId: 'd', updatedAt: 0 }).success
    ).toBe(false)
  })
})

describe('SignatureMetadataSchema', () => {
  it('accepts ed25519 signature metadata', () => {
    const result = SignatureMetadataSchema.safeParse({
      signerDeviceId: 'd1',
      signerPublicKey: 'pk',
      signedAt: 0,
      algorithm: 'ed25519'
    })
    expect(result.success).toBe(true)
  })

  it('rejects non-ed25519 algorithm', () => {
    const result = SignatureMetadataSchema.safeParse({
      signerDeviceId: 'd1',
      signerPublicKey: 'pk',
      signedAt: 0,
      algorithm: 'rsa'
    })
    expect(result.success).toBe(false)
    if (!result.success) {
      expect(result.error.issues[0].path).toContain('algorithm')
    }
  })
})
