import { describe, expect, it } from 'vitest'

import {
  DeviceRegisterRequestSchema,
  RequestOtpRequestSchema,
  VerifyOtpRequestSchema
} from '@memry/contracts/auth-api'
import { ChunkUploadParamsSchema, UploadInitRequestSchema } from '@memry/contracts/blob-api'
import { CBOR_FIELD_ORDER } from '@memry/contracts/cbor-ordering'
import { CRYPTO_VERSION, EncryptedItemSchema } from '@memry/contracts/crypto'
import {
  ConfirmRecoveryPhraseSchema,
  RequestOtpSchema,
  SetupFirstDeviceSchema,
  AUTH_CHANNELS
} from '@memry/contracts/ipc-auth'
import {
  CRYPTO_CHANNELS,
  DecryptItemSchema,
  EncryptItemSchema,
  RotateKeysSchema,
  VerifySignatureSchema
} from '@memry/contracts/ipc-crypto'
import {
  ApproveLinkingSchema,
  DEVICE_CHANNELS,
  LinkViaQrSchema,
  RemoveDeviceSchema,
  RenameDeviceSchema
} from '@memry/contracts/ipc-devices'
import {
  ATTACHMENT_CHANNELS,
  DownloadAttachmentSchema,
  GetDownloadProgressSchema,
  UploadAttachmentSchema
} from '@memry/contracts/ipc-attachments'
import { CRDT_CHANNELS, CRDT_EVENTS } from '@memry/contracts/ipc-crdt'
import { EVENT_CHANNELS } from '@memry/contracts/ipc-events'
import { GetHistorySchema, SYNC_OP_CHANNELS } from '@memry/contracts/ipc-sync-ops'
import { SYNC_CHANNELS, SYNC_EVENTS } from '@memry/contracts/ipc-sync'
import {
  InitiateLinkingRequestSchema,
  LINKING_SESSION_STATUSES
} from '@memry/contracts/linking-api'
import { PushRequestSchema, SYNC_ITEM_TYPES, VectorClockSchema } from '@memry/contracts/sync-api'

describe('sync-server contracts', () => {
  it('validates API contract schemas', () => {
    expect(RequestOtpRequestSchema.safeParse({ email: 'user@example.com' }).success).toBe(true)
    expect(
      VerifyOtpRequestSchema.safeParse({ email: 'user@example.com', code: '654321' }).success
    ).toBe(true)
    expect(
      DeviceRegisterRequestSchema.safeParse({
        name: 'Laptop',
        platform: 'macos',
        appVersion: '1.0.0',
        authPublicKey: 'pk',
        challengeSignature: 'sig',
        challengeNonce: 'nonce'
      }).success
    ).toBe(true)

    expect(
      UploadInitRequestSchema.safeParse({
        attachmentId: 'att-1',
        filename: 'file.bin',
        totalSize: 2048,
        chunkCount: 4
      }).success
    ).toBe(true)
    expect(ChunkUploadParamsSchema.safeParse({ sessionId: 's1', chunkIndex: -1 }).success).toBe(
      false
    )
  })

  it('validates crypto and sync payload schemas', () => {
    expect(
      EncryptedItemSchema.safeParse({
        id: 'item-1',
        type: 'task',
        cryptoVersion: CRYPTO_VERSION,
        encryptedKey: 'ek',
        keyNonce: 'kn',
        encryptedData: 'ed',
        dataNonce: 'dn',
        signature: 'sig',
        signerDeviceId: 'device-1'
      }).success
    ).toBe(true)

    expect(VectorClockSchema.safeParse({ deviceA: 1 }).success).toBe(true)
    expect(VectorClockSchema.safeParse({ deviceA: -1 }).success).toBe(false)

    expect(
      PushRequestSchema.safeParse({
        items: [
          {
            id: 'ab99c922-6f3b-4bbf-a589-2d4f96f8ec95',
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

    expect(SYNC_ITEM_TYPES).toContain('note')
    expect(CBOR_FIELD_ORDER.SYNC_ITEM).toContain('encryptedData')
  })

  it('validates linking and IPC schema surfaces', () => {
    expect(InitiateLinkingRequestSchema.safeParse({ ephemeralPublicKey: 'pk' }).success).toBe(true)
    expect(LINKING_SESSION_STATUSES).toContain('approved')

    expect(RequestOtpSchema.safeParse({ email: 'user@example.com' }).success).toBe(true)
    expect(
      SetupFirstDeviceSchema.safeParse({ oauthToken: 'oauth', provider: 'google', state: 'abc' })
        .success
    ).toBe(true)
    expect(ConfirmRecoveryPhraseSchema.safeParse({ confirmed: true }).success).toBe(true)

    expect(
      EncryptItemSchema.safeParse({
        itemId: 'item-1',
        type: 'task',
        content: { title: 'x' }
      }).success
    ).toBe(true)
    expect(
      DecryptItemSchema.safeParse({
        itemId: 'item-1',
        type: 'task',
        encryptedKey: 'ek',
        keyNonce: 'kn',
        encryptedData: 'ed',
        dataNonce: 'dn',
        signature: 'sig'
      }).success
    ).toBe(true)
    expect(
      VerifySignatureSchema.safeParse({
        itemId: 'item-1',
        type: 'task',
        encryptedKey: 'ek',
        keyNonce: 'kn',
        encryptedData: 'ed',
        dataNonce: 'dn',
        signature: 'sig'
      }).success
    ).toBe(true)
    expect(RotateKeysSchema.safeParse({ confirm: true }).success).toBe(true)

    expect(
      LinkViaQrSchema.safeParse({ qrData: 'qr', oauthToken: 'oauth', provider: 'google' }).success
    ).toBe(true)
    expect(ApproveLinkingSchema.safeParse({ sessionId: 'session' }).success).toBe(true)
    expect(RemoveDeviceSchema.safeParse({ deviceId: 'device-1' }).success).toBe(true)
    expect(
      RenameDeviceSchema.safeParse({ deviceId: 'device-1', newName: 'New Name' }).success
    ).toBe(true)

    expect(UploadAttachmentSchema.safeParse({ noteId: 'n1', filePath: '/tmp/file' }).success).toBe(
      true
    )
    expect(
      DownloadAttachmentSchema.safeParse({ attachmentId: 'a1', targetPath: '/tmp/file' }).success
    ).toBe(true)
    expect(GetDownloadProgressSchema.safeParse({ attachmentId: 'a1' }).success).toBe(true)

    expect(GetHistorySchema.safeParse({ limit: 20, offset: 0 }).success).toBe(true)
  })

  it('merges channel/event maps without collisions', () => {
    expect(SYNC_CHANNELS).toEqual({
      ...AUTH_CHANNELS,
      ...CRYPTO_CHANNELS,
      ...SYNC_OP_CHANNELS,
      ...DEVICE_CHANNELS,
      ...ATTACHMENT_CHANNELS,
      ...CRDT_CHANNELS
    })

    expect(SYNC_EVENTS).toEqual({ ...EVENT_CHANNELS, ...CRDT_EVENTS })
    expect(new Set(Object.values(SYNC_CHANNELS)).size).toBe(Object.keys(SYNC_CHANNELS).length)
    expect(new Set(Object.values(SYNC_EVENTS)).size).toBe(Object.keys(SYNC_EVENTS).length)
  })
})
