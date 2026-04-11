import { describe, expect, it } from 'vitest'

import {
  DeviceRegisterRequestSchema,
  RequestOtpRequestSchema,
  VerifyOtpRequestSchema
} from './auth-api'
import { ChunkUploadParamsSchema, UploadInitRequestSchema } from './blob-api'
import { CBOR_FIELD_ORDER } from './cbor-ordering'
import {
  CRYPTO_VERSION,
  EncryptedItemSchema,
  SignaturePayloadV1Schema,
  XCHACHA20_PARAMS
} from './crypto'
import {
  CompleteLinkingResponseSchema,
  InitiateLinkingRequestSchema,
  LINKING_SESSION_STATUSES
} from './linking-api'
import {
  PushRequestSchema,
  RecordChangesResponseSchema,
  RecordPullResponseSchema,
  RecordPushRequestSchema,
  RecordSyncManifestSchema,
  SignatureMetadataSchema,
  SyncItemSchema,
  VectorClockSchema,
  SYNC_ITEM_TYPES,
  SYNC_OPERATIONS
} from './sync-api'
import {
  AUTH_CHANNELS,
  ATTACHMENT_CHANNELS,
  CRDT_CHANNELS,
  CRDT_EVENTS,
  CRYPTO_CHANNELS,
  DEVICE_CHANNELS,
  EVENT_CHANNELS,
  SYNC_CHANNELS,
  SYNC_EVENTS,
  SYNC_OP_CHANNELS
} from './ipc-sync'

describe('sync phase contract schemas', () => {
  it('validates auth request formats', () => {
    expect(RequestOtpRequestSchema.safeParse({ email: 'user@example.com' }).success).toBe(true)
    expect(RequestOtpRequestSchema.safeParse({ email: 'bad-email' }).success).toBe(false)

    expect(
      VerifyOtpRequestSchema.safeParse({ email: 'user@example.com', code: '123456' }).success
    ).toBe(true)
    expect(
      VerifyOtpRequestSchema.safeParse({ email: 'user@example.com', code: '12345' }).success
    ).toBe(false)

    expect(
      DeviceRegisterRequestSchema.safeParse({
        name: 'My Mac',
        platform: 'macos',
        appVersion: '1.0.0',
        authPublicKey: 'pk',
        challengeSignature: 'sig',
        challengeNonce: 'nonce'
      }).success
    ).toBe(true)
  })

  it('validates blob upload constraints', () => {
    expect(
      UploadInitRequestSchema.safeParse({
        attachmentId: 'att-1',
        filename: 'image.png',
        totalSize: 1024,
        chunkCount: 2
      }).success
    ).toBe(true)

    expect(
      UploadInitRequestSchema.safeParse({
        attachmentId: 'att-1',
        filename: 'image.png',
        totalSize: 0,
        chunkCount: 2
      }).success
    ).toBe(false)

    expect(ChunkUploadParamsSchema.safeParse({ sessionId: 's1', chunkIndex: 0 }).success).toBe(true)
    expect(ChunkUploadParamsSchema.safeParse({ sessionId: 's1', chunkIndex: -1 }).success).toBe(
      false
    )
  })

  it('keeps CBOR ordering contract stable and duplicate-free', () => {
    expect(CBOR_FIELD_ORDER.SYNC_ITEM).toEqual([
      'id',
      'type',
      'operation',
      'cryptoVersion',
      'encryptedKey',
      'keyNonce',
      'encryptedData',
      'dataNonce',
      'deletedAt',
      'metadata'
    ])

    for (const fieldList of Object.values(CBOR_FIELD_ORDER)) {
      const unique = new Set(fieldList)
      expect(unique.size).toBe(fieldList.length)
    }
  })

  it('validates encrypted payload contracts', () => {
    const encryptedItem = {
      id: 'item-1',
      type: 'note',
      cryptoVersion: CRYPTO_VERSION,
      encryptedKey: 'ek',
      keyNonce: 'kn',
      encryptedData: 'ed',
      dataNonce: 'dn',
      signature: 'sig',
      signerDeviceId: 'device-1'
    }

    expect(EncryptedItemSchema.safeParse(encryptedItem).success).toBe(true)
    expect(EncryptedItemSchema.safeParse({ ...encryptedItem, cryptoVersion: 2 }).success).toBe(true)
    expect(EncryptedItemSchema.safeParse({ ...encryptedItem, cryptoVersion: 0 }).success).toBe(
      false
    )
    expect(EncryptedItemSchema.safeParse({ ...encryptedItem, cryptoVersion: 100 }).success).toBe(
      false
    )

    expect(
      SignaturePayloadV1Schema.safeParse({
        id: 'item-1',
        type: 'task',
        operation: 'update',
        cryptoVersion: CRYPTO_VERSION,
        encryptedKey: 'ek',
        keyNonce: 'kn',
        encryptedData: 'ed',
        dataNonce: 'dn',
        metadata: {
          clock: { deviceA: 2 },
          stateVector: 'sv'
        }
      }).success
    ).toBe(true)

    expect(XCHACHA20_PARAMS.NONCE_LENGTH).toBe(24)
  })

  it('validates linking status and response payloads', () => {
    expect(InitiateLinkingRequestSchema.safeParse({ ephemeralPublicKey: 'pk' }).success).toBe(true)
    expect(InitiateLinkingRequestSchema.safeParse({ ephemeralPublicKey: '' }).success).toBe(false)

    expect(
      CompleteLinkingResponseSchema.safeParse({
        success: true,
        encryptedMasterKey: 'master',
        encryptedKeyNonce: 'nonce',
        keyConfirm: 'confirm'
      }).success
    ).toBe(true)

    expect(LINKING_SESSION_STATUSES).toContain('pending')
    expect(LINKING_SESSION_STATUSES).toContain('completed')
  })

  it('validates sync request envelopes and metadata', () => {
    expect(VectorClockSchema.safeParse({ deviceA: 1, deviceB: 0 }).success).toBe(true)
    expect(VectorClockSchema.safeParse({ deviceA: -1 }).success).toBe(false)

    const validItem = {
      id: 'ab99c922-6f3b-4bbf-a589-2d4f96f8ec95',
      userId: 'user-1',
      itemType: 'task',
      itemId: 'task-1',
      blobKey: 'user/items/task-1',
      sizeBytes: 123,
      contentHash: 'hash',
      version: 1,
      cryptoVersion: 1,
      serverCursor: 1,
      signerDeviceId: 'device-1',
      signature: 'sig',
      createdAt: 1,
      updatedAt: 2
    }

    expect(SyncItemSchema.safeParse(validItem).success).toBe(true)
    expect(SyncItemSchema.safeParse({ ...validItem, id: 'not-uuid' }).success).toBe(false)

    expect(
      PushRequestSchema.safeParse({
        items: [
          {
            id: validItem.id,
            type: 'task',
            operation: 'create',
            encryptedKey: 'ek',
            keyNonce: 'kn',
            encryptedData: 'ed',
            dataNonce: 'dn',
            signature: 'sig',
            signerDeviceId: 'device-1'
          }
        ]
      }).success
    ).toBe(true)

    expect(
      RecordPushRequestSchema.safeParse({
        items: [
          {
            id: validItem.id,
            type: 'task',
            operation: 'create',
            encryptedKey: 'ek',
            keyNonce: 'kn',
            encryptedData: 'ed',
            dataNonce: 'dn',
            signature: 'sig',
            signerDeviceId: 'device-1',
            clock: { deviceA: 1 }
          }
        ]
      }).success
    ).toBe(true)

    expect(
      RecordPushRequestSchema.safeParse({
        items: [
          {
            id: validItem.id,
            type: 'attachment',
            operation: 'create',
            encryptedKey: 'ek',
            keyNonce: 'kn',
            encryptedData: 'ed',
            dataNonce: 'dn',
            signature: 'sig',
            signerDeviceId: 'device-1'
          }
        ]
      }).success
    ).toBe(false)

    expect(
      RecordPushRequestSchema.safeParse({
        items: [
          {
            id: validItem.id,
            type: 'task',
            operation: 'create',
            encryptedKey: 'ek',
            keyNonce: 'kn',
            encryptedData: 'ed',
            dataNonce: 'dn',
            signature: 'sig',
            signerDeviceId: 'device-1'
          }
        ]
      }).success
    ).toBe(false)

    expect(
      RecordPushRequestSchema.safeParse({
        items: [
          {
            id: validItem.id,
            type: 'calendar_event',
            operation: 'create',
            encryptedKey: 'ek',
            keyNonce: 'kn',
            encryptedData: 'ed',
            dataNonce: 'dn',
            signature: 'sig',
            signerDeviceId: 'device-1',
            clock: { deviceA: 1 }
          }
        ]
      }).success
    ).toBe(true)

    expect(
      RecordPushRequestSchema.safeParse({
        items: [
          {
            id: validItem.id,
            type: 'settings',
            operation: 'update',
            encryptedKey: 'ek',
            keyNonce: 'kn',
            encryptedData: 'ed',
            dataNonce: 'dn',
            signature: 'sig',
            signerDeviceId: 'device-1'
          }
        ]
      }).success
    ).toBe(true)

    expect(
      RecordSyncManifestSchema.safeParse({
        items: [
          {
            id: validItem.id,
            type: 'note',
            version: 1,
            modifiedAt: 2,
            size: 123
          }
        ],
        serverTime: 3
      }).success
    ).toBe(true)

    expect(
      RecordSyncManifestSchema.safeParse({
        items: [
          {
            id: validItem.id,
            type: 'attachment',
            version: 1,
            modifiedAt: 2,
            size: 123
          }
        ],
        serverTime: 3
      }).success
    ).toBe(false)

    expect(
      RecordChangesResponseSchema.safeParse({
        items: [
          {
            id: validItem.id,
            type: 'task',
            version: 1,
            modifiedAt: 2,
            size: 123
          }
        ],
        deleted: [],
        hasMore: false,
        nextCursor: 1
      }).success
    ).toBe(true)

    expect(
      RecordPullResponseSchema.safeParse({
        items: [
          {
            id: validItem.id,
            type: 'task',
            operation: 'update',
            cryptoVersion: 1,
            signature: 'sig',
            signerDeviceId: 'device-1',
            blob: {
              encryptedKey: 'ek',
              keyNonce: 'kn',
              encryptedData: 'ed',
              dataNonce: 'dn'
            }
          }
        ]
      }).success
    ).toBe(true)

    expect(
      RecordPullResponseSchema.safeParse({
        items: [
          {
            id: validItem.id,
            type: 'attachment',
            operation: 'update',
            signature: 'sig',
            signerDeviceId: 'device-1',
            blob: {
              encryptedKey: 'ek',
              keyNonce: 'kn',
              encryptedData: 'ed',
              dataNonce: 'dn'
            }
          }
        ]
      }).success
    ).toBe(false)

    expect(
      PushRequestSchema.safeParse({
        items: new Array(101).fill({
          id: validItem.id,
          type: 'task',
          operation: 'create',
          encryptedKey: 'ek',
          keyNonce: 'kn',
          encryptedData: 'ed',
          dataNonce: 'dn',
          signature: 'sig',
          signerDeviceId: 'device-1'
        })
      }).success
    ).toBe(false)

    expect(
      SignatureMetadataSchema.safeParse({
        signerDeviceId: 'device-1',
        signerPublicKey: 'pk',
        signedAt: 123,
        algorithm: 'ed25519'
      }).success
    ).toBe(true)

    expect(SYNC_ITEM_TYPES).toContain('note')
    expect(SYNC_ITEM_TYPES).toContain('calendar_event')
    expect(SYNC_ITEM_TYPES).toContain('calendar_source')
    expect(SYNC_ITEM_TYPES).toContain('calendar_binding')
    expect(SYNC_ITEM_TYPES).toContain('calendar_external_event')
    expect(SYNC_OPERATIONS).toContain('delete')
  })

  it('aggregates IPC sync channels and events without key collisions', () => {
    const sourceChannels = {
      ...AUTH_CHANNELS,
      ...CRYPTO_CHANNELS,
      ...SYNC_OP_CHANNELS,
      ...DEVICE_CHANNELS,
      ...ATTACHMENT_CHANNELS,
      ...CRDT_CHANNELS
    }

    expect(SYNC_CHANNELS).toEqual(sourceChannels)
    expect(new Set(Object.keys(SYNC_CHANNELS)).size).toBe(Object.keys(SYNC_CHANNELS).length)

    expect(SYNC_EVENTS).toEqual({ ...EVENT_CHANNELS, ...CRDT_EVENTS })
    expect(new Set(Object.keys(SYNC_EVENTS)).size).toBe(Object.keys(SYNC_EVENTS).length)
  })
})
