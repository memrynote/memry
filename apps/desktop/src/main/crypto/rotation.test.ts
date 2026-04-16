import sodium from 'libsodium-wrappers-sumo'
import { beforeAll, describe, expect, it, vi } from 'vitest'

import { CBOR_FIELD_ORDER } from '@memry/contracts/cbor-ordering'
import { CRYPTO_VERSION, ED25519_PARAMS, XCHACHA20_PARAMS } from '@memry/contracts/crypto'
import type { PullItemResponse, PushItem } from '@memry/contracts/sync-api'

import { encrypt, unwrapFileKey, wrapFileKey } from './encryption'
import { signPayload, verifySignature } from './signatures'
import {
  performKeyRotation,
  rewrapCrdtSnapshot,
  rewrapItemKey,
  type CrdtSnapshotInfo,
  type RotationDeps,
  type RotationState
} from './rotation'

beforeAll(async () => {
  await sodium.ready
})

const toB64 = (b: Uint8Array): string => sodium.to_base64(b, sodium.base64_variants.ORIGINAL)
const fromB64 = (s: string): Uint8Array => sodium.from_base64(s, sodium.base64_variants.ORIGINAL)

const makeVaultKey = (): Uint8Array => sodium.randombytes_buf(XCHACHA20_PARAMS.KEY_LENGTH)
const makeFileKey = (): Uint8Array => sodium.randombytes_buf(XCHACHA20_PARAMS.KEY_LENGTH)

interface SigningPair {
  publicKey: Uint8Array
  secretKey: Uint8Array
  deviceId: string
}

const makeSigningPair = (): SigningPair => {
  const kp = sodium.crypto_sign_keypair()
  const publicKey = new Uint8Array(kp.publicKey)
  const secretKey = new Uint8Array(kp.privateKey)
  const deviceId = sodium.to_hex(sodium.crypto_generichash(16, publicKey, null))
  return { publicKey, secretKey, deviceId }
}

interface BuildItemArgs {
  id: string
  type: 'note' | 'task' | 'project' | 'journal'
  operation: 'create' | 'update' | 'delete'
  vaultKey: Uint8Array
  signingKeys: SigningPair
  clock?: Record<string, number>
  stateVector?: string
  deletedAt?: number
}

const buildPullItem = (args: BuildItemArgs): PullItemResponse => {
  const fileKey = makeFileKey()
  const wrapped = wrapFileKey(fileKey, args.vaultKey)

  const data = encrypt(new TextEncoder().encode(`payload-for-${args.id}`), fileKey)

  const encryptedKey = toB64(wrapped.wrappedKey)
  const keyNonce = toB64(wrapped.nonce)
  const encryptedData = toB64(data.ciphertext)
  const dataNonce = toB64(data.nonce)

  const signaturePayload: Record<string, unknown> = {
    id: args.id,
    type: args.type,
    operation: args.operation,
    cryptoVersion: CRYPTO_VERSION,
    encryptedKey,
    keyNonce,
    encryptedData,
    dataNonce
  }

  if (args.deletedAt !== undefined) signaturePayload.deletedAt = args.deletedAt

  if (args.clock || args.stateVector) {
    const metadata: Record<string, unknown> = {}
    if (args.clock) metadata.clock = args.clock
    if (args.stateVector) metadata.stateVector = args.stateVector
    signaturePayload.metadata = metadata
  }

  const signature = signPayload(
    signaturePayload,
    CBOR_FIELD_ORDER.SYNC_ITEM,
    args.signingKeys.secretKey
  )

  sodium.memzero(fileKey)

  return {
    id: args.id,
    type: args.type,
    operation: args.operation,
    cryptoVersion: CRYPTO_VERSION,
    signature: toB64(signature),
    signerDeviceId: args.signingKeys.deviceId,
    deletedAt: args.deletedAt,
    clock: args.clock,
    stateVector: args.stateVector,
    blob: { encryptedKey, keyNonce, encryptedData, dataNonce }
  }
}

const verifyPushSignature = (item: PushItem, publicKey: Uint8Array): boolean => {
  const payload: Record<string, unknown> = {
    id: item.id,
    type: item.type,
    operation: item.operation,
    cryptoVersion: CRYPTO_VERSION,
    encryptedKey: item.encryptedKey,
    keyNonce: item.keyNonce,
    encryptedData: item.encryptedData,
    dataNonce: item.dataNonce
  }
  if (item.deletedAt !== undefined) payload.deletedAt = item.deletedAt
  if (item.clock || item.stateVector) {
    const metadata: Record<string, unknown> = {}
    if (item.clock) metadata.clock = item.clock
    if (item.stateVector) metadata.stateVector = item.stateVector
    payload.metadata = metadata
  }
  return verifySignature(payload, CBOR_FIELD_ORDER.SYNC_ITEM, fromB64(item.signature), publicKey)
}

describe('rewrapItemKey', () => {
  it('rewraps the file key under the new vault key while preserving the encrypted body', () => {
    // #given an item encrypted under oldVaultKey
    const oldVaultKey = makeVaultKey()
    const newVaultKey = makeVaultKey()
    const signing = makeSigningPair()
    const item = buildPullItem({
      id: 'item-001',
      type: 'task',
      operation: 'update',
      vaultKey: oldVaultKey,
      signingKeys: signing,
      clock: { 'device-a': 3 }
    })

    // #when rewrapping with the new vault key
    const result = rewrapItemKey(
      item,
      oldVaultKey,
      newVaultKey,
      signing.secretKey,
      signing.deviceId
    )

    // #then the encrypted data and nonce are byte-identical (only the key wrapper changed)
    expect(result.pushItem.encryptedData).toBe(item.blob.encryptedData)
    expect(result.pushItem.dataNonce).toBe(item.blob.dataNonce)

    // #and the new wrapped key is different from the old wrapped key
    expect(result.pushItem.encryptedKey).not.toBe(item.blob.encryptedKey)
    expect(result.pushItem.keyNonce).not.toBe(item.blob.keyNonce)

    // #and the file key recovered with newVaultKey matches the file key recovered with oldVaultKey
    const oldFileKey = unwrapFileKey(
      fromB64(item.blob.encryptedKey),
      fromB64(item.blob.keyNonce),
      oldVaultKey
    )
    const newFileKey = unwrapFileKey(
      fromB64(result.pushItem.encryptedKey),
      fromB64(result.pushItem.keyNonce),
      newVaultKey
    )
    expect(newFileKey).toEqual(oldFileKey)

    // #and metadata fields (clock, signerDeviceId, originalId) survive intact
    expect(result.originalId).toBe('item-001')
    expect(result.pushItem.id).toBe('item-001')
    expect(result.pushItem.signerDeviceId).toBe(signing.deviceId)
    expect(result.pushItem.clock).toEqual({ 'device-a': 3 })

    // #and the new signature verifies against the signing public key
    expect(verifyPushSignature(result.pushItem, signing.publicKey)).toBe(true)
  })

  it('preserves the deletedAt field in the rewrapped push item and its signature', () => {
    // #given a tombstone item with deletedAt
    const oldVaultKey = makeVaultKey()
    const newVaultKey = makeVaultKey()
    const signing = makeSigningPair()
    const deletedAt = 1_700_000_000
    const item = buildPullItem({
      id: 'item-tomb',
      type: 'task',
      operation: 'delete',
      vaultKey: oldVaultKey,
      signingKeys: signing,
      deletedAt
    })

    // #when rewrapping
    const result = rewrapItemKey(
      item,
      oldVaultKey,
      newVaultKey,
      signing.secretKey,
      signing.deviceId
    )

    // #then deletedAt is preserved and the signature still verifies
    expect(result.pushItem.deletedAt).toBe(deletedAt)
    expect(verifyPushSignature(result.pushItem, signing.publicKey)).toBe(true)
  })

  it('preserves stateVector metadata when present', () => {
    // #given a CRDT-typed item with a stateVector
    const oldVaultKey = makeVaultKey()
    const newVaultKey = makeVaultKey()
    const signing = makeSigningPair()
    const stateVector = toB64(sodium.randombytes_buf(8))
    const item = buildPullItem({
      id: 'note-sv',
      type: 'note',
      operation: 'update',
      vaultKey: oldVaultKey,
      signingKeys: signing,
      stateVector
    })

    // #when rewrapping
    const result = rewrapItemKey(
      item,
      oldVaultKey,
      newVaultKey,
      signing.secretKey,
      signing.deviceId
    )

    // #then the stateVector survives and the signature verifies
    expect(result.pushItem.stateVector).toBe(stateVector)
    expect(verifyPushSignature(result.pushItem, signing.publicKey)).toBe(true)
  })

  it('throws when the key nonce has the wrong length', () => {
    // #given an item whose keyNonce is malformed (too short)
    const oldVaultKey = makeVaultKey()
    const newVaultKey = makeVaultKey()
    const signing = makeSigningPair()
    const item = buildPullItem({
      id: 'bad-nonce',
      type: 'task',
      operation: 'update',
      vaultKey: oldVaultKey,
      signingKeys: signing
    })
    const broken: PullItemResponse = {
      ...item,
      blob: { ...item.blob, keyNonce: toB64(new Uint8Array(8)) }
    }

    // #when rewrapping
    // #then it throws a length-mismatch error referencing the item id
    expect(() =>
      rewrapItemKey(broken, oldVaultKey, newVaultKey, signing.secretKey, signing.deviceId)
    ).toThrow(/Invalid key nonce length for item bad-nonce/)
  })
})

const CRDT_NONCE_LEN = XCHACHA20_PARAMS.NONCE_LENGTH
const CRDT_WRAPPED_KEY_LEN = XCHACHA20_PARAMS.KEY_LENGTH + XCHACHA20_PARAMS.TAG_LENGTH
const CRDT_SIG_LEN = ED25519_PARAMS.SIGNATURE_LENGTH
const CRDT_HEADER_LEN = CRDT_NONCE_LEN + CRDT_NONCE_LEN + CRDT_WRAPPED_KEY_LEN + CRDT_SIG_LEN

interface BuiltSnapshot {
  packed: Uint8Array
  fileKey: Uint8Array
}

const buildCrdtSnapshot = (
  noteId: string,
  vaultKey: Uint8Array,
  signing: SigningPair,
  body: Uint8Array
): BuiltSnapshot => {
  const fileKey = makeFileKey()
  const wrapped = wrapFileKey(fileKey, vaultKey)
  const snapshotNonce = sodium.randombytes_buf(CRDT_NONCE_LEN)

  const packed = new Uint8Array(CRDT_HEADER_LEN + body.length)
  packed.set(snapshotNonce, 0)
  packed.set(wrapped.nonce, CRDT_NONCE_LEN)
  packed.set(wrapped.wrappedKey, CRDT_NONCE_LEN + CRDT_NONCE_LEN)
  packed.set(body, CRDT_HEADER_LEN)

  const sigOffset = CRDT_NONCE_LEN + CRDT_NONCE_LEN + CRDT_WRAPPED_KEY_LEN
  const noteIdBytes = new TextEncoder().encode(noteId)
  const beforeSig = packed.subarray(0, sigOffset)
  const afterSig = packed.subarray(sigOffset + CRDT_SIG_LEN)
  const payload = new Uint8Array(noteIdBytes.length + beforeSig.length + afterSig.length)
  payload.set(noteIdBytes, 0)
  payload.set(beforeSig, noteIdBytes.length)
  payload.set(afterSig, noteIdBytes.length + beforeSig.length)
  const signature = sodium.crypto_sign_detached(payload, signing.secretKey)
  packed.set(signature, sigOffset)

  return { packed, fileKey: new Uint8Array(fileKey) }
}

const verifyCrdtSnapshotSignature = (
  packed: Uint8Array,
  noteId: string,
  publicKey: Uint8Array
): boolean => {
  const sigOffset = CRDT_NONCE_LEN + CRDT_NONCE_LEN + CRDT_WRAPPED_KEY_LEN
  const signature = packed.subarray(sigOffset, sigOffset + CRDT_SIG_LEN)
  const noteIdBytes = new TextEncoder().encode(noteId)
  const beforeSig = packed.subarray(0, sigOffset)
  const afterSig = packed.subarray(sigOffset + CRDT_SIG_LEN)
  const payload = new Uint8Array(noteIdBytes.length + beforeSig.length + afterSig.length)
  payload.set(noteIdBytes, 0)
  payload.set(beforeSig, noteIdBytes.length)
  payload.set(afterSig, noteIdBytes.length + beforeSig.length)
  return sodium.crypto_sign_verify_detached(signature, payload, publicKey)
}

describe('rewrapCrdtSnapshot', () => {
  it('keeps the encrypted body bytes intact while re-wrapping the key under the new vault key', () => {
    // #given a CRDT snapshot encrypted under oldVaultKey
    const oldVaultKey = makeVaultKey()
    const newVaultKey = makeVaultKey()
    const signing = makeSigningPair()
    const noteId = 'note-crdt-001'
    const body = sodium.randombytes_buf(128)
    const built = buildCrdtSnapshot(noteId, oldVaultKey, signing, body)

    // #when rewrapping under newVaultKey
    const rewrapped = rewrapCrdtSnapshot(
      built.packed,
      noteId,
      oldVaultKey,
      newVaultKey,
      signing.secretKey
    )

    // #then the snapshot length is unchanged
    expect(rewrapped).toHaveLength(built.packed.length)

    // #and the snapshot nonce (first 24 bytes) is byte-identical
    expect(rewrapped.subarray(0, CRDT_NONCE_LEN)).toEqual(built.packed.subarray(0, CRDT_NONCE_LEN))

    // #and the encrypted body (after the header) is byte-identical
    expect(rewrapped.subarray(CRDT_HEADER_LEN)).toEqual(built.packed.subarray(CRDT_HEADER_LEN))

    // #and the wrapped key region differs from the original
    const oldWrapped = built.packed.subarray(
      CRDT_NONCE_LEN + CRDT_NONCE_LEN,
      CRDT_NONCE_LEN + CRDT_NONCE_LEN + CRDT_WRAPPED_KEY_LEN
    )
    const newWrapped = rewrapped.subarray(
      CRDT_NONCE_LEN + CRDT_NONCE_LEN,
      CRDT_NONCE_LEN + CRDT_NONCE_LEN + CRDT_WRAPPED_KEY_LEN
    )
    expect(newWrapped).not.toEqual(oldWrapped)

    // #and the file key recovered with newVaultKey matches the original file key
    const newKeyNonce = rewrapped.subarray(CRDT_NONCE_LEN, CRDT_NONCE_LEN + CRDT_NONCE_LEN)
    const recoveredFileKey = unwrapFileKey(newWrapped, newKeyNonce, newVaultKey)
    expect(recoveredFileKey).toEqual(built.fileKey)

    // #and the new signature verifies under the signing public key
    expect(verifyCrdtSnapshotSignature(rewrapped, noteId, signing.publicKey)).toBe(true)
  })

  it('throws when the packed snapshot is shorter than the header', () => {
    // #given a snapshot smaller than the fixed header (+1 body byte)
    const oldVaultKey = makeVaultKey()
    const newVaultKey = makeVaultKey()
    const signing = makeSigningPair()
    const tooSmall = new Uint8Array(CRDT_HEADER_LEN)

    // #then rewrapping rejects with a length error
    expect(() =>
      rewrapCrdtSnapshot(tooSmall, 'note-x', oldVaultKey, newVaultKey, signing.secretKey)
    ).toThrow(/CRDT snapshot too short for rewrap:/)
  })
})

interface RotationFixture {
  oldVaultKey: Uint8Array
  newVaultKey: Uint8Array
  newKdfSalt: string
  newKeyVerifier: string
  newMasterKey: Uint8Array
  signing: SigningPair
  items: PullItemResponse[]
  manifestItems: Array<{ id: string; type: string }>
  noteIds: string[]
  crdtSnapshots: CrdtSnapshotInfo[]
}

const buildRotationFixture = (opts?: {
  taskCount?: number
  noteCount?: number
}): RotationFixture => {
  const taskCount = opts?.taskCount ?? 2
  const noteCount = opts?.noteCount ?? 1
  const oldVaultKey = makeVaultKey()
  const newVaultKey = makeVaultKey()
  const signing = makeSigningPair()

  const items: PullItemResponse[] = []
  const manifestItems: Array<{ id: string; type: string }> = []

  for (let i = 0; i < taskCount; i++) {
    const id = `task-${i}`
    items.push(
      buildPullItem({
        id,
        type: 'task',
        operation: 'update',
        vaultKey: oldVaultKey,
        signingKeys: signing
      })
    )
    manifestItems.push({ id, type: 'task' })
  }

  const noteIds: string[] = []
  const crdtSnapshots: CrdtSnapshotInfo[] = []
  for (let i = 0; i < noteCount; i++) {
    const id = `note-${i}`
    noteIds.push(id)
    items.push(
      buildPullItem({
        id,
        type: 'note',
        operation: 'update',
        vaultKey: oldVaultKey,
        signingKeys: signing,
        stateVector: toB64(sodium.randombytes_buf(4))
      })
    )
    manifestItems.push({ id, type: 'note' })
    const snap = buildCrdtSnapshot(id, oldVaultKey, signing, sodium.randombytes_buf(64))
    crdtSnapshots.push({ noteId: id, snapshot: snap.packed, sequenceNum: i + 1 })
  }

  return {
    oldVaultKey,
    newVaultKey,
    newKdfSalt: toB64(sodium.randombytes_buf(16)),
    newKeyVerifier: toB64(sodium.randombytes_buf(32)),
    newMasterKey: sodium.randombytes_buf(32),
    signing,
    items,
    manifestItems,
    noteIds,
    crdtSnapshots
  }
}

interface DepsHarness {
  deps: RotationDeps
  states: RotationState[]
  pushedItems: PushItem[][]
  pushedSnapshots: Array<{ noteId: string; snapshot: Uint8Array }>
  serverKeyUpdates: Array<{ kdfSalt: string; keyVerifier: string }>
  storedMasterKeys: Uint8Array[]
  pauseCount: { value: number }
  resumeCount: { value: number }
}

const makeDepsHarness = (
  fixture: RotationFixture,
  overrides?: Partial<RotationDeps>
): DepsHarness => {
  const states: RotationState[] = []
  const pushedItems: PushItem[][] = []
  const pushedSnapshots: Array<{ noteId: string; snapshot: Uint8Array }> = []
  const serverKeyUpdates: Array<{ kdfSalt: string; keyVerifier: string }> = []
  const storedMasterKeys: Uint8Array[] = []
  const pauseCount = { value: 0 }
  const resumeCount = { value: 0 }

  const deps: RotationDeps = {
    getAccessToken: vi.fn(async () => 'access-token'),
    getVaultKey: vi.fn(async () => new Uint8Array(fixture.oldVaultKey)),
    getSigningKeys: vi.fn(async () => ({
      secretKey: new Uint8Array(fixture.signing.secretKey),
      publicKey: new Uint8Array(fixture.signing.publicKey),
      deviceId: fixture.signing.deviceId
    })),
    fetchManifest: vi.fn(async () => ({ items: fixture.manifestItems })),
    pullItems: vi.fn(async (_token: string, ids: string[]) =>
      ids.map((id) => {
        const found = fixture.items.find((it) => it.id === id)
        if (!found) throw new Error(`unexpected pull for id ${id}`)
        return found
      })
    ),
    pushItems: vi.fn(async (_token: string, items: PushItem[]) => {
      pushedItems.push(items)
      return { accepted: items.map((i) => i.id), rejected: [] }
    }),
    fetchCrdtSnapshots: vi.fn(async (_token: string, noteIds: string[]) =>
      fixture.crdtSnapshots.filter((s) => noteIds.includes(s.noteId))
    ),
    pushCrdtSnapshot: vi.fn(async (_token: string, noteId: string, snapshot: Uint8Array) => {
      pushedSnapshots.push({ noteId, snapshot })
    }),
    updateServerKeys: vi.fn(async (_token: string, kdfSalt: string, keyVerifier: string) => {
      serverKeyUpdates.push({ kdfSalt, keyVerifier })
    }),
    pauseSync: vi.fn(() => {
      pauseCount.value++
    }),
    resumeSync: vi.fn(() => {
      resumeCount.value++
    }),
    storeNewMasterKey: vi.fn(async (key: Uint8Array) => {
      storedMasterKeys.push(new Uint8Array(key))
    }),
    onProgress: vi.fn((state: RotationState) => {
      states.push({ ...state })
    }),
    ...overrides
  }

  return {
    deps,
    states,
    pushedItems,
    pushedSnapshots,
    serverKeyUpdates,
    storedMasterKeys,
    pauseCount,
    resumeCount
  }
}

describe('performKeyRotation', () => {
  it('rotates all items and CRDT snapshots, emitting progress through every phase', async () => {
    // #given a fixture with two task items and one note (with one CRDT snapshot)
    const fixture = buildRotationFixture({ taskCount: 2, noteCount: 1 })
    const harness = makeDepsHarness(fixture)

    // #when performing key rotation
    const result = await performKeyRotation(
      harness.deps,
      new Uint8Array(fixture.newVaultKey),
      fixture.newKdfSalt,
      fixture.newKeyVerifier,
      new Uint8Array(fixture.newMasterKey)
    )

    // #then the rotation reports success
    expect(result.success).toBe(true)
    expect(result.error).toBeUndefined()

    // #and the progress callback walked through preparing → re-encrypting → finalizing → complete
    const phases = harness.states.map((s) => s.phase)
    expect(phases[0]).toBe('preparing')
    expect(phases).toContain('re-encrypting')
    expect(phases).toContain('finalizing')
    expect(phases[phases.length - 1]).toBe('complete')

    // #and processedItems counts up monotonically from 0 to totalItems
    const processed = harness.states.map((s) => s.processedItems)
    for (let i = 1; i < processed.length; i++) {
      expect(processed[i]).toBeGreaterThanOrEqual(processed[i - 1])
    }
    const finalState = harness.states[harness.states.length - 1]
    expect(finalState.processedItems).toBe(fixture.manifestItems.length + fixture.noteIds.length)
    expect(finalState.totalItems).toBe(finalState.processedItems)
    expect(finalState.inProgress).toBe(false)
    expect(finalState.error).toBeUndefined()

    // #and the sync was paused and then resumed exactly once
    expect(harness.pauseCount.value).toBe(1)
    expect(harness.resumeCount.value).toBe(1)

    // #and pushItems was called with one batch containing every item
    expect(harness.pushedItems).toHaveLength(1)
    expect(harness.pushedItems[0]).toHaveLength(fixture.items.length)

    // #and every pushed item is wrapped under the new vault key
    for (const pushItem of harness.pushedItems[0]) {
      const fileKey = unwrapFileKey(
        fromB64(pushItem.encryptedKey),
        fromB64(pushItem.keyNonce),
        fixture.newVaultKey
      )
      expect(fileKey).toHaveLength(XCHACHA20_PARAMS.KEY_LENGTH)
      expect(verifyPushSignature(pushItem, fixture.signing.publicKey)).toBe(true)
    }

    // #and one CRDT snapshot was pushed, signed correctly under the new vault key
    expect(harness.pushedSnapshots).toHaveLength(1)
    const pushed = harness.pushedSnapshots[0]
    expect(pushed.noteId).toBe('note-0')
    expect(
      verifyCrdtSnapshotSignature(pushed.snapshot, pushed.noteId, fixture.signing.publicKey)
    ).toBe(true)

    // #and the server keys were updated and the new master key was stored
    expect(harness.serverKeyUpdates).toEqual([
      { kdfSalt: fixture.newKdfSalt, keyVerifier: fixture.newKeyVerifier }
    ])
    expect(harness.storedMasterKeys).toHaveLength(1)
  })

  it('returns success:false when getAccessToken yields null and never pauses sync', async () => {
    // #given a deps harness whose getAccessToken returns null
    const fixture = buildRotationFixture({ taskCount: 0, noteCount: 0 })
    const harness = makeDepsHarness(fixture, { getAccessToken: vi.fn(async () => null) })

    // #when running rotation
    const result = await performKeyRotation(
      harness.deps,
      new Uint8Array(fixture.newVaultKey),
      fixture.newKdfSalt,
      fixture.newKeyVerifier,
      new Uint8Array(fixture.newMasterKey)
    )

    // #then it short-circuits before pausing sync or touching the server
    expect(result).toEqual({ success: false, error: 'No access token available' })
    expect(harness.pauseCount.value).toBe(0)
    expect(harness.resumeCount.value).toBe(0)
    expect(harness.serverKeyUpdates).toHaveLength(0)
  })

  it('returns success:false when getSigningKeys yields null', async () => {
    // #given a deps harness whose getSigningKeys returns null
    const fixture = buildRotationFixture({ taskCount: 0, noteCount: 0 })
    const harness = makeDepsHarness(fixture, { getSigningKeys: vi.fn(async () => null) })

    // #when running rotation
    const result = await performKeyRotation(
      harness.deps,
      new Uint8Array(fixture.newVaultKey),
      fixture.newKdfSalt,
      fixture.newKeyVerifier,
      new Uint8Array(fixture.newMasterKey)
    )

    // #then it returns the missing-keys error without pausing sync
    expect(result).toEqual({ success: false, error: 'No signing keys available' })
    expect(harness.pauseCount.value).toBe(0)
  })

  it('returns success:false when getVaultKey yields null', async () => {
    // #given a deps harness whose getVaultKey returns null
    const fixture = buildRotationFixture({ taskCount: 0, noteCount: 0 })
    const harness = makeDepsHarness(fixture, { getVaultKey: vi.fn(async () => null) })

    // #when running rotation
    const result = await performKeyRotation(
      harness.deps,
      new Uint8Array(fixture.newVaultKey),
      fixture.newKdfSalt,
      fixture.newKeyVerifier,
      new Uint8Array(fixture.newMasterKey)
    )

    // #then it reports the derivation failure
    expect(result).toEqual({ success: false, error: 'Cannot derive current vault key' })
    expect(harness.pauseCount.value).toBe(0)
  })

  it('aborts when an item fails mid-rotation, reports the error, and resumes sync', async () => {
    // #given a fixture where the second pulled item is malformed (rewrap will throw on it)
    // The implementation catches per-item rewrap failures and aborts after the loop with
    // a "Rotation aborted: N items failed re-wrap" error. Successful items still hit
    // pushItems for that batch — the rejection is the post-loop guard.
    const fixture = buildRotationFixture({ taskCount: 3, noteCount: 0 })
    const failingId = fixture.items[1].id
    fixture.items[1] = {
      ...fixture.items[1],
      blob: { ...fixture.items[1].blob, keyNonce: toB64(new Uint8Array(8)) }
    }
    const harness = makeDepsHarness(fixture)

    // #when running rotation
    const result = await performKeyRotation(
      harness.deps,
      new Uint8Array(fixture.newVaultKey),
      fixture.newKdfSalt,
      fixture.newKeyVerifier,
      new Uint8Array(fixture.newMasterKey)
    )

    // #then rotation reports failure with a count and message
    expect(result.success).toBe(false)
    expect(result.error).toMatch(/Rotation aborted: 1 items failed re-wrap/)

    // #and pushItems was called only with the successfully rewrapped items (excluding the failing one)
    expect(harness.pushedItems).toHaveLength(1)
    const pushedIds = harness.pushedItems[0].map((i) => i.id)
    expect(pushedIds).not.toContain(failingId)
    expect(pushedIds).toHaveLength(fixture.items.length - 1)

    // #and processedItems still counts every attempted item (success + failure)
    const finalState = harness.states[harness.states.length - 1]
    expect(finalState.processedItems).toBe(fixture.items.length)
    expect(finalState.error).toMatch(/Rotation aborted/)
    expect(finalState.inProgress).toBe(false)

    // #and the server keys were NOT updated and the master key was NOT stored
    expect(harness.serverKeyUpdates).toHaveLength(0)
    expect(harness.storedMasterKeys).toHaveLength(0)

    // #and sync was paused and then resumed (so the app is not left frozen)
    expect(harness.pauseCount.value).toBe(1)
    expect(harness.resumeCount.value).toBe(1)
  })

  it('treats server-rejected push items as failures and aborts the rotation', async () => {
    // #given a fixture whose pushItems response rejects one item
    const fixture = buildRotationFixture({ taskCount: 2, noteCount: 0 })
    const rejectedId = fixture.items[0].id
    const harness = makeDepsHarness(fixture, {
      pushItems: vi.fn(async (_token: string, items: PushItem[]) => ({
        accepted: items.filter((i) => i.id !== rejectedId).map((i) => i.id),
        rejected: [{ id: rejectedId, reason: 'simulated server rejection' }]
      }))
    })

    // #when running rotation
    const result = await performKeyRotation(
      harness.deps,
      new Uint8Array(fixture.newVaultKey),
      fixture.newKdfSalt,
      fixture.newKeyVerifier,
      new Uint8Array(fixture.newMasterKey)
    )

    // #then the rotation aborts with the failure count
    expect(result.success).toBe(false)
    expect(result.error).toMatch(/Rotation aborted: 1 items failed re-wrap/)

    // #and the server keys were not advanced
    expect(harness.serverKeyUpdates).toHaveLength(0)
  })

  it('aborts when a CRDT snapshot fails to rewrap, recording it in failedItems', async () => {
    // #given a note item whose CRDT snapshot is malformed (too short for header)
    const fixture = buildRotationFixture({ taskCount: 0, noteCount: 1 })
    fixture.crdtSnapshots[0] = {
      ...fixture.crdtSnapshots[0],
      snapshot: new Uint8Array(CRDT_HEADER_LEN)
    }
    const harness = makeDepsHarness(fixture)

    // #when running rotation
    const result = await performKeyRotation(
      harness.deps,
      new Uint8Array(fixture.newVaultKey),
      fixture.newKdfSalt,
      fixture.newKeyVerifier,
      new Uint8Array(fixture.newMasterKey)
    )

    // #then the rotation reports failure with the CRDT snapshot in the abort message
    expect(result.success).toBe(false)
    expect(result.error).toMatch(/Rotation aborted: 1 items failed re-wrap/)

    // #and the regular item-push happened (note item itself rewraps fine)
    expect(harness.pushedItems[0]).toHaveLength(1)

    // #and no CRDT snapshot was pushed (the only one failed)
    expect(harness.pushedSnapshots).toHaveLength(0)

    // #and the server keys were NOT advanced
    expect(harness.serverKeyUpdates).toHaveLength(0)
  })

  it('still calls resumeSync when an unexpected error is thrown by a dependency', async () => {
    // #given fetchManifest throws
    const fixture = buildRotationFixture({ taskCount: 1, noteCount: 0 })
    const harness = makeDepsHarness(fixture, {
      fetchManifest: vi.fn(async () => {
        throw new Error('manifest unreachable')
      })
    })

    // #when running rotation
    const result = await performKeyRotation(
      harness.deps,
      new Uint8Array(fixture.newVaultKey),
      fixture.newKdfSalt,
      fixture.newKeyVerifier,
      new Uint8Array(fixture.newMasterKey)
    )

    // #then the error surfaces and resumeSync is called from the catch path
    expect(result).toEqual({ success: false, error: 'manifest unreachable' })
    expect(harness.pauseCount.value).toBe(1)
    expect(harness.resumeCount.value).toBe(1)
  })
})
