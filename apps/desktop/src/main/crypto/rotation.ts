import sodium from 'libsodium-wrappers-sumo'

import { createLogger } from '../lib/logger'
import { wrapFileKey, unwrapFileKey } from './encryption'
import { signPayload } from './signatures'
import { secureCleanup } from './index'
import { CBOR_FIELD_ORDER } from '@memry/contracts/cbor-ordering'
import { XCHACHA20_PARAMS, ED25519_PARAMS, CRYPTO_VERSION } from '@memry/contracts/crypto'
import type { RotationPhase } from '@memry/contracts/ipc-crypto'
import type { PushItem, PullItemResponse } from '@memry/contracts/sync-api'

const log = createLogger('KeyRotation')

export interface RotationState {
  inProgress: boolean
  phase: RotationPhase
  totalItems: number
  processedItems: number
  error?: string
}

export interface RewrapResult {
  pushItem: PushItem
  originalId: string
}

export function rewrapItemKey(
  item: PullItemResponse,
  oldVaultKey: Uint8Array,
  newVaultKey: Uint8Array,
  signingSecretKey: Uint8Array,
  signerDeviceId: string
): RewrapResult {
  const fromB64 = (s: string): Uint8Array => sodium.from_base64(s, sodium.base64_variants.ORIGINAL)
  const toB64 = (b: Uint8Array): string => sodium.to_base64(b, sodium.base64_variants.ORIGINAL)

  const encryptedKey = fromB64(item.blob.encryptedKey)
  const keyNonce = fromB64(item.blob.keyNonce)

  if (keyNonce.length !== XCHACHA20_PARAMS.NONCE_LENGTH) {
    throw new Error(`Invalid key nonce length for item ${item.id}`)
  }

  let fileKey: Uint8Array | undefined

  try {
    fileKey = unwrapFileKey(encryptedKey, keyNonce, oldVaultKey)
    const rewrapped = wrapFileKey(fileKey, newVaultKey)

    const newEncryptedKeyB64 = toB64(rewrapped.wrappedKey)
    const newKeyNonceB64 = toB64(rewrapped.nonce)

    const signaturePayload: Record<string, unknown> = {
      id: item.id,
      type: item.type,
      operation: item.operation,
      cryptoVersion: CRYPTO_VERSION,
      encryptedKey: newEncryptedKeyB64,
      keyNonce: newKeyNonceB64,
      encryptedData: item.blob.encryptedData,
      dataNonce: item.blob.dataNonce
    }

    if (item.deletedAt !== undefined) {
      signaturePayload.deletedAt = item.deletedAt
    }

    if (item.clock || item.stateVector) {
      const metadata: Record<string, unknown> = {}
      if (item.clock) metadata.clock = item.clock
      if (item.stateVector) metadata.stateVector = item.stateVector
      signaturePayload.metadata = metadata
    }

    const signature = signPayload(signaturePayload, CBOR_FIELD_ORDER.SYNC_ITEM, signingSecretKey)

    return {
      originalId: item.id,
      pushItem: {
        id: item.id,
        type: item.type,
        operation: item.operation,
        encryptedKey: newEncryptedKeyB64,
        keyNonce: newKeyNonceB64,
        encryptedData: item.blob.encryptedData,
        dataNonce: item.blob.dataNonce,
        signature: toB64(signature),
        signerDeviceId,
        ...(item.clock && { clock: item.clock }),
        ...(item.stateVector && { stateVector: item.stateVector }),
        ...(item.deletedAt !== undefined && { deletedAt: item.deletedAt })
      }
    }
  } finally {
    if (fileKey) secureCleanup(fileKey)
  }
}

const CRDT_NONCE_LEN = XCHACHA20_PARAMS.NONCE_LENGTH
const CRDT_WRAPPED_KEY_LEN = XCHACHA20_PARAMS.KEY_LENGTH + XCHACHA20_PARAMS.TAG_LENGTH
const CRDT_SIGNATURE_LEN = ED25519_PARAMS.SIGNATURE_LENGTH

export function rewrapCrdtSnapshot(
  packed: Uint8Array,
  noteId: string,
  oldVaultKey: Uint8Array,
  newVaultKey: Uint8Array,
  signingSecretKey: Uint8Array
): Uint8Array {
  const headerLen = CRDT_NONCE_LEN + CRDT_NONCE_LEN + CRDT_WRAPPED_KEY_LEN + CRDT_SIGNATURE_LEN
  if (packed.length < headerLen + 1) {
    throw new Error(`CRDT snapshot too short for rewrap: ${packed.length} bytes`)
  }

  const keyNonceOffset = CRDT_NONCE_LEN
  const wrappedKeyOffset = CRDT_NONCE_LEN + CRDT_NONCE_LEN
  const sigOffset = wrappedKeyOffset + CRDT_WRAPPED_KEY_LEN

  const keyNonce = packed.subarray(keyNonceOffset, wrappedKeyOffset)
  const oldWrappedKey = packed.subarray(wrappedKeyOffset, sigOffset)

  let fileKey: Uint8Array | undefined

  try {
    fileKey = unwrapFileKey(oldWrappedKey, keyNonce, oldVaultKey)
    const rewrapped = wrapFileKey(fileKey, newVaultKey)

    const result = new Uint8Array(packed.length)
    result.set(packed)

    result.set(rewrapped.nonce, keyNonceOffset)
    result.set(rewrapped.wrappedKey, wrappedKeyOffset)

    const noteIdBytes = new TextEncoder().encode(noteId)
    const beforeSig = result.subarray(0, sigOffset)
    const afterSig = result.subarray(sigOffset + CRDT_SIGNATURE_LEN)
    const payload = new Uint8Array(noteIdBytes.length + beforeSig.length + afterSig.length)
    payload.set(noteIdBytes, 0)
    payload.set(beforeSig, noteIdBytes.length)
    payload.set(afterSig, noteIdBytes.length + beforeSig.length)

    const signature = sodium.crypto_sign_detached(payload, signingSecretKey)
    result.set(signature, sigOffset)

    return result
  } finally {
    if (fileKey) secureCleanup(fileKey)
  }
}

export interface CrdtSnapshotInfo {
  noteId: string
  snapshot: Uint8Array
  sequenceNum: number
}

export interface RotationDeps {
  getAccessToken: () => Promise<string | null>
  getVaultKey: () => Promise<Uint8Array | null>
  getSigningKeys: () => Promise<{
    secretKey: Uint8Array
    publicKey: Uint8Array
    deviceId: string
  } | null>
  fetchManifest: (token: string) => Promise<{ items: Array<{ id: string; type: string }> }>
  pullItems: (token: string, itemIds: string[]) => Promise<PullItemResponse[]>
  pushItems: (
    token: string,
    items: PushItem[]
  ) => Promise<{ accepted: string[]; rejected: Array<{ id: string; reason: string }> }>
  fetchCrdtSnapshots: (token: string, noteIds: string[]) => Promise<CrdtSnapshotInfo[]>
  pushCrdtSnapshot: (token: string, noteId: string, snapshot: Uint8Array) => Promise<void>
  updateServerKeys: (token: string, kdfSalt: string, keyVerifier: string) => Promise<void>
  pauseSync: () => void
  resumeSync: () => void
  storeNewMasterKey: (masterKey: Uint8Array) => Promise<void>
  onProgress: (state: RotationState) => void
}

const ROTATION_BATCH_SIZE = 50

export async function performKeyRotation(
  deps: RotationDeps,
  newVaultKey: Uint8Array,
  newKdfSalt: string,
  newKeyVerifier: string,
  newMasterKey: Uint8Array
): Promise<{ success: boolean; error?: string }> {
  let state: RotationState = {
    inProgress: true,
    phase: 'preparing',
    totalItems: 0,
    processedItems: 0
  }

  const emitProgress = (): void => deps.onProgress({ ...state })

  let oldVaultKey: Uint8Array | undefined
  let signingKeys: { secretKey: Uint8Array; publicKey: Uint8Array; deviceId: string } | null = null

  try {
    emitProgress()

    const token = await deps.getAccessToken()
    if (!token) return { success: false, error: 'No access token available' }

    signingKeys = await deps.getSigningKeys()
    if (!signingKeys) return { success: false, error: 'No signing keys available' }

    const vk = await deps.getVaultKey()
    if (!vk) return { success: false, error: 'Cannot derive current vault key' }
    oldVaultKey = vk

    deps.pauseSync()
    log.info('Sync paused for key rotation')

    const manifest = await deps.fetchManifest(token)
    const noteIds = manifest.items
      .filter((i) => i.type === 'note' || i.type === 'journal')
      .map((i) => i.id)

    state.totalItems = manifest.items.length + noteIds.length
    state.phase = 're-encrypting'
    emitProgress()

    log.info('Key rotation started', { totalItems: state.totalItems })

    const allItemIds = manifest.items.map((i) => i.id)
    const failedItems: string[] = []

    for (let offset = 0; offset < allItemIds.length; offset += ROTATION_BATCH_SIZE) {
      const batchIds = allItemIds.slice(offset, offset + ROTATION_BATCH_SIZE)

      const items = await deps.pullItems(token, batchIds)

      const rewrapped: PushItem[] = []

      for (const item of items) {
        try {
          const result = rewrapItemKey(
            item,
            oldVaultKey,
            newVaultKey,
            signingKeys.secretKey,
            signingKeys.deviceId
          )
          rewrapped.push(result.pushItem)
        } catch (err) {
          log.error('Failed to rewrap item', { itemId: item.id, error: err })
          failedItems.push(item.id)
        }

        state.processedItems++
        emitProgress()
      }

      if (rewrapped.length > 0) {
        const pushResult = await deps.pushItems(token, rewrapped)

        if (pushResult.rejected.length > 0) {
          for (const r of pushResult.rejected) {
            failedItems.push(r.id)
          }
          log.error('Items rejected during rotation push', {
            rejectedCount: pushResult.rejected.length,
            reasons: pushResult.rejected.map((r) => r.reason)
          })
        }
      }
    }

    if (noteIds.length > 0) {
      log.info('Rewrapping CRDT snapshots', { count: noteIds.length })

      for (let offset = 0; offset < noteIds.length; offset += ROTATION_BATCH_SIZE) {
        const batchNoteIds = noteIds.slice(offset, offset + ROTATION_BATCH_SIZE)

        const snapshots = await deps.fetchCrdtSnapshots(token, batchNoteIds)

        for (const snap of snapshots) {
          try {
            const rewrappedSnap = rewrapCrdtSnapshot(
              snap.snapshot,
              snap.noteId,
              oldVaultKey,
              newVaultKey,
              signingKeys.secretKey
            )
            await deps.pushCrdtSnapshot(token, snap.noteId, rewrappedSnap)
          } catch (err) {
            log.error('Failed to rewrap CRDT snapshot', { noteId: snap.noteId, error: err })
            failedItems.push(`crdt:${snap.noteId}`)
          }

          state.processedItems++
          emitProgress()
        }
      }
    }

    if (failedItems.length > 0) {
      const msg = `Rotation aborted: ${failedItems.length} items failed re-wrap`
      log.error(msg, { failedItems: failedItems.slice(0, 20) })
      throw new Error(msg)
    }

    state.phase = 'finalizing'
    emitProgress()

    await deps.updateServerKeys(token, newKdfSalt, newKeyVerifier)
    log.info('Key rotation server keys updated')

    await deps.storeNewMasterKey(newMasterKey)
    log.info('New master key stored in keychain')

    state.phase = 'complete'
    state.inProgress = false
    emitProgress()

    deps.resumeSync()
    log.info('Key rotation complete', { processedItems: state.processedItems })

    return { success: true }
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Key rotation failed'
    log.error('Key rotation failed', err)

    state.error = message
    state.inProgress = false
    emitProgress()

    deps.resumeSync()
    return { success: false, error: message }
  } finally {
    if (oldVaultKey) secureCleanup(oldVaultKey)
    if (signingKeys) secureCleanup(signingKeys.secretKey)
    secureCleanup(newVaultKey, newMasterKey)
  }
}
