import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { writeFile, mkdtemp, rm } from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import sodium from 'libsodium-wrappers-sumo'

import {
  AttachmentSyncService,
  type AttachmentSyncDeps,
  type TransferProgress
} from './attachments'
import { generateFileKey } from '../crypto/keys'
import { signPayload } from '../crypto/signatures'
import { CBOR_FIELD_ORDER } from '@memry/contracts/cbor-ordering'

let tmpDir: string

/**
 * Passthrough mock of fs/promises whose `open` can be told to start failing
 * writes with ENOSPC mid-transfer (`failWritesAfter` successful writes), so
 * disk-full behaviour is exercised against a REAL partial file on disk.
 */
const fsMockState = vi.hoisted(() => ({
  failWritesAfter: Number.POSITIVE_INFINITY,
  writeCount: 0
}))

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  return {
    ...actual,
    open: (async (...args: Parameters<typeof actual.open>) => {
      const handle = await actual.open(...args)
      const write = handle.write.bind(handle)
      handle.write = (async (...writeArgs: Parameters<typeof write>) => {
        if (fsMockState.writeCount >= fsMockState.failWritesAfter) {
          throw Object.assign(new Error('write failed: no space left on device'), {
            code: 'ENOSPC'
          })
        }
        fsMockState.writeCount++
        return write(...writeArgs)
      }) as typeof handle.write
      return handle
    }) as typeof actual.open
  }
})

function createMockFetch(
  responses: Map<string, { status: number; body?: unknown; binary?: Uint8Array }>
) {
  return vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    const urlStr = typeof url === 'string' ? url : url instanceof URL ? url.toString() : url.url
    const method = init?.method ?? 'GET'

    for (const [pattern, resp] of responses) {
      const [expectedMethod, ...pathParts] = pattern.split(' ')
      const expectedPath = pathParts.join(' ')
      if (method === expectedMethod && urlStr.includes(expectedPath)) {
        return new Response(
          resp.binary ? resp.binary : resp.body !== undefined ? JSON.stringify(resp.body) : null,
          {
            status: resp.status,
            headers: resp.binary
              ? { 'Content-Type': 'application/octet-stream' }
              : { 'Content-Type': 'application/json' }
          }
        )
      }
    }

    return new Response(JSON.stringify({ error: `No mock for ${method} ${urlStr}` }), {
      status: 404
    })
  })
}

function createTestDeps(fetchFn: ReturnType<typeof vi.fn>): AttachmentSyncDeps {
  return {
    getAccessToken: vi.fn().mockResolvedValue('test-token'),
    getVaultKey: vi.fn().mockResolvedValue(generateFileKey()),
    getSigningKeys: vi.fn().mockResolvedValue({
      secretKey: sodium.crypto_sign_keypair().privateKey,
      publicKey: sodium.crypto_sign_keypair().publicKey,
      deviceId: 'device-1'
    }),
    getDevicePublicKey: vi.fn().mockResolvedValue(sodium.crypto_sign_keypair().publicKey),
    getSyncServerUrl: () => 'http://localhost:8787',
    fetchFn
  }
}

function createDeferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void
  const promise = new Promise<void>((r) => {
    resolve = r
  })
  return { promise, resolve }
}

/** Single-chunk encrypted manifest + its on-the-wire chunk (nonce || ciphertext). */
function buildSignedManifest(opts: {
  attachmentId: string
  filename: string
  plaintext: Buffer
  vaultKey: Uint8Array
  signingKeypair: { privateKey: Uint8Array; publicKey: Uint8Array }
  /** Override the whole-file checksum to force an integrity failure after the chunk decrypts. */
  checksum?: string
}): { encManifest: Record<string, string>; encryptedChunk: Uint8Array } {
  const toB64 = (b: Uint8Array): string => sodium.to_base64(b, sodium.base64_variants.ORIGINAL)
  const fileKey = generateFileKey()

  const chunkNonce = sodium.randombytes_buf(24)
  const chunkCiphertext = sodium.crypto_aead_xchacha20poly1305_ietf_encrypt(
    opts.plaintext,
    null,
    null,
    chunkNonce,
    fileKey
  )
  const encryptedChunk = new Uint8Array(chunkNonce.length + chunkCiphertext.length)
  encryptedChunk.set(chunkNonce, 0)
  encryptedChunk.set(chunkCiphertext, chunkNonce.length)

  const plaintextHash = sodium.to_hex(sodium.crypto_hash_sha256(opts.plaintext))
  const manifest = {
    id: opts.attachmentId,
    filename: opts.filename,
    mimeType: 'text/plain',
    size: opts.plaintext.length,
    checksum: opts.checksum ?? plaintextHash,
    chunks: [
      {
        index: 0,
        hash: plaintextHash,
        encryptedHash: sodium.to_hex(sodium.crypto_hash_sha256(encryptedChunk)),
        size: opts.plaintext.length
      }
    ],
    chunkSize: 8388608,
    createdAt: Date.now()
  }

  const manifestNonce = sodium.randombytes_buf(24)
  const manifestCiphertext = sodium.crypto_aead_xchacha20poly1305_ietf_encrypt(
    new TextEncoder().encode(JSON.stringify(manifest)),
    null,
    null,
    manifestNonce,
    fileKey
  )
  const keyNonce = sodium.randombytes_buf(24)
  const wrappedKey = sodium.crypto_aead_xchacha20poly1305_ietf_encrypt(
    fileKey,
    null,
    null,
    keyNonce,
    opts.vaultKey
  )

  const signaturePayload: Record<string, unknown> = {
    encryptedManifest: toB64(manifestCiphertext),
    manifestNonce: toB64(manifestNonce),
    encryptedFileKey: toB64(wrappedKey),
    keyNonce: toB64(keyNonce)
  }
  const manifestSignature = signPayload(
    signaturePayload,
    CBOR_FIELD_ORDER.ATTACHMENT_MANIFEST,
    opts.signingKeypair.privateKey
  )

  return {
    encManifest: {
      ...(signaturePayload as Record<string, string>),
      manifestSignature: toB64(manifestSignature),
      signerDeviceId: 'device-1'
    },
    encryptedChunk
  }
}

function createDownloadDeps(
  fetchFn: ReturnType<typeof vi.fn>,
  vaultKey: Uint8Array,
  signerPublicKey: Uint8Array
): AttachmentSyncDeps {
  return {
    ...createTestDeps(fetchFn),
    getVaultKey: vi.fn().mockResolvedValue(vaultKey),
    getDevicePublicKey: vi.fn().mockResolvedValue(signerPublicKey)
  }
}

beforeEach(async () => {
  await sodium.ready
  tmpDir = await mkdtemp(path.join(os.tmpdir(), 'memry-attach-test-'))
  fsMockState.failWritesAfter = Number.POSITIVE_INFINITY
  fsMockState.writeCount = 0
})

afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true })
})

describe('AttachmentSyncService', () => {
  describe('uploadAttachment', () => {
    it('should chunk, encrypt, and upload a small file', async () => {
      const testFile = path.join(tmpDir, 'test.txt')
      const content = Buffer.alloc(1024, 'A')
      await writeFile(testFile, content)

      const responses = new Map<string, { status: number; body?: unknown; binary?: Uint8Array }>()
      responses.set('POST /attachments/upload/initiate', {
        status: 200,
        body: { sessionId: 'session-1', expiresAt: Date.now() + 3600000 }
      })
      responses.set('GET /attachments/upload/session-1', {
        status: 200,
        body: {
          sessionId: 'session-1',
          attachmentId: '',
          totalSize: 0,
          chunkCount: 1,
          uploadedChunks: [],
          expiresAt: 0
        }
      })
      responses.set('HEAD /attachments/chunks/', { status: 404 })
      responses.set('PUT /attachments/upload/session-1/chunk/', {
        status: 200,
        body: { success: true, uploadedChunks: 1 }
      })
      responses.set('POST /attachments/upload/session-1/complete', {
        status: 200,
        body: { success: true }
      })

      const mockFetch = createMockFetch(responses)
      const deps = createTestDeps(mockFetch)
      const service = new AttachmentSyncService(deps)

      const progressEvents: TransferProgress[] = []
      service.setProgressCallback((p) => progressEvents.push({ ...p }))

      const result = await service.uploadAttachment('note-1', testFile)

      expect(result.attachmentId).toBeTruthy()
      expect(result.sessionId).toBe('session-1')
      expect(result.manifest.filename).toBe('test.txt')
      expect(result.manifest.size).toBe(1024)
      expect(result.manifest.chunks).toHaveLength(1)
      expect(result.manifest.checksum).toBeTruthy()

      expect(progressEvents.length).toBeGreaterThan(0)
      expect(progressEvents.some((p) => p.phase === 'uploading')).toBe(true)
    })

    it('should reject nonexistent files', async () => {
      const testFile = path.join(tmpDir, 'does-not-exist.bin')

      const mockFetch = createMockFetch(new Map())
      const deps = createTestDeps(mockFetch)
      const service = new AttachmentSyncService(deps)

      await expect(service.uploadAttachment('note-1', testFile)).rejects.toThrow()
    })

    it('should reject empty files', async () => {
      const testFile = path.join(tmpDir, 'empty.bin')
      await writeFile(testFile, Buffer.alloc(0))

      const mockFetch = createMockFetch(new Map())
      const deps = createTestDeps(mockFetch)
      const service = new AttachmentSyncService(deps)

      await expect(service.uploadAttachment('note-1', testFile)).rejects.toThrow('empty file')
    })

    it('uploads every chunk without probing for server-side dedup', async () => {
      // The old client HEAD-probed each chunk hash for dedup before uploading.
      // That probe could never hit: the file key is random per upload and the
      // nonce is random per chunk, so `encryptedHash` is unique every time. It
      // cost a guaranteed-miss round-trip per chunk (and produced the 404 noise
      // on HEAD /sync/attachments/chunks/:hash). Pin that it is gone.
      const testFile = path.join(tmpDir, 'dedup.txt')
      await writeFile(testFile, Buffer.alloc(512, 'B'))

      const responses = new Map<string, { status: number; body?: unknown; binary?: Uint8Array }>()
      responses.set('POST /attachments/upload/initiate', {
        status: 200,
        body: { sessionId: 'session-2', expiresAt: Date.now() + 3600000 }
      })
      responses.set('GET /attachments/upload/session-2', {
        status: 200,
        body: {
          sessionId: 'session-2',
          attachmentId: '',
          totalSize: 0,
          chunkCount: 1,
          uploadedChunks: [],
          expiresAt: 0
        }
      })
      responses.set('PUT /attachments/upload/session-2/chunk/0', {
        status: 200,
        body: { success: true, uploadedChunks: 1 }
      })
      responses.set('POST /attachments/upload/session-2/complete', {
        status: 200,
        body: { success: true }
      })

      const mockFetch = createMockFetch(responses)
      const deps = createTestDeps(mockFetch)
      const service = new AttachmentSyncService(deps)

      const result = await service.uploadAttachment('note-1', testFile)
      expect(result.sessionId).toBe('session-2')

      const putCalls = mockFetch.mock.calls.filter(
        ([url, init]: [string, RequestInit]) =>
          init?.method === 'PUT' && typeof url === 'string' && url.includes('/chunk/')
      )
      expect(putCalls).toHaveLength(1)

      const headCalls = mockFetch.mock.calls.filter(
        ([, init]: [string, RequestInit]) => init?.method === 'HEAD'
      )
      expect(headCalls).toHaveLength(0)
    })

    it('declares the encrypted byte total, not the plaintext size, on initiate', async () => {
      // Regression guard for the 58-day outage: chunks go on the wire as
      // nonce || ciphertext, so the bytes stored exceed the plaintext size.
      const testFile = path.join(tmpDir, 'sizes.txt')
      await writeFile(testFile, Buffer.alloc(512, 'D'))

      const responses = new Map<string, { status: number; body?: unknown; binary?: Uint8Array }>()
      responses.set('POST /attachments/upload/initiate', {
        status: 200,
        body: { sessionId: 'session-3', expiresAt: Date.now() + 3600000 }
      })
      responses.set('GET /attachments/upload/session-3', {
        status: 200,
        body: {
          sessionId: 'session-3',
          attachmentId: '',
          totalSize: 0,
          chunkCount: 1,
          uploadedChunks: [],
          expiresAt: 0
        }
      })
      responses.set('PUT /attachments/upload/session-3/chunk/0', {
        status: 200,
        body: { success: true, uploadedChunks: 1 }
      })
      responses.set('POST /attachments/upload/session-3/complete', {
        status: 200,
        body: { success: true }
      })

      const mockFetch = createMockFetch(responses)
      const service = new AttachmentSyncService(createTestDeps(mockFetch))
      await service.uploadAttachment('note-1', testFile)

      const initiateCall = mockFetch.mock.calls.find(
        ([url, init]: [string, RequestInit]) =>
          init?.method === 'POST' && typeof url === 'string' && url.includes('/initiate')
      )
      const body = JSON.parse((initiateCall![1] as RequestInit).body as string)
      expect(body.totalSize).toBe(512)
      // nonce(24) + Poly1305 tag(16) on the single chunk.
      expect(body.encryptedSize).toBe(512 + 40)
    })

    it('rejects a file over the cached plan limit before reading or encrypting it', async () => {
      const testFile = path.join(tmpDir, 'toobig.txt')
      await writeFile(testFile, Buffer.alloc(2048, 'E'))

      const mockFetch = createMockFetch(new Map())
      const deps: AttachmentSyncDeps = {
        ...createTestDeps(mockFetch),
        getMaxFileSize: () => 1024
      }
      const service = new AttachmentSyncService(deps)

      await expect(service.uploadAttachment('note-1', testFile)).rejects.toThrow(
        /larger than your plan allows/i
      )
      // Nothing hit the network: the point is to avoid the read+hash+encrypt pass.
      expect(mockFetch).not.toHaveBeenCalled()
    })

    it('falls back to server authority when the cached plan limit is unknown', async () => {
      // The entitlement cache is only warm after a billing fetch. A cold cache
      // must never block an upload.
      const testFile = path.join(tmpDir, 'unknown-limit.txt')
      await writeFile(testFile, Buffer.alloc(2048, 'F'))

      const responses = new Map<string, { status: number; body?: unknown; binary?: Uint8Array }>()
      responses.set('POST /attachments/upload/initiate', {
        status: 200,
        body: { sessionId: 'session-4', expiresAt: Date.now() + 3600000 }
      })
      responses.set('GET /attachments/upload/session-4', {
        status: 200,
        body: {
          sessionId: 'session-4',
          attachmentId: '',
          totalSize: 0,
          chunkCount: 1,
          uploadedChunks: [],
          expiresAt: 0
        }
      })
      responses.set('PUT /attachments/upload/session-4/chunk/0', {
        status: 200,
        body: { success: true, uploadedChunks: 1 }
      })
      responses.set('POST /attachments/upload/session-4/complete', {
        status: 200,
        body: { success: true }
      })

      const mockFetch = createMockFetch(responses)
      const deps: AttachmentSyncDeps = {
        ...createTestDeps(mockFetch),
        getMaxFileSize: () => null
      }
      const service = new AttachmentSyncService(deps)

      await expect(service.uploadAttachment('note-1', testFile)).resolves.toBeTruthy()
    })
  })

  describe('downloadAttachment', () => {
    it('should download, decrypt, and verify a file', async () => {
      const vaultKey = generateFileKey()
      const fileKey = generateFileKey()

      const plaintext = Buffer.alloc(256, 'C')
      const plaintextHash = sodium.to_hex(sodium.crypto_hash_sha256(plaintext))
      const wholeFileHash = plaintextHash

      const nonce = sodium.randombytes_buf(24)
      const ciphertext = sodium.crypto_aead_xchacha20poly1305_ietf_encrypt(
        plaintext,
        null,
        null,
        nonce,
        fileKey
      )
      const encryptedWithNonce = new Uint8Array(nonce.length + ciphertext.length)
      encryptedWithNonce.set(nonce, 0)
      encryptedWithNonce.set(ciphertext, nonce.length)

      const encryptedHash = sodium.to_hex(sodium.crypto_hash_sha256(encryptedWithNonce))

      const manifest = {
        id: 'att-1',
        filename: 'download.txt',
        mimeType: 'text/plain',
        size: 256,
        checksum: wholeFileHash,
        chunks: [{ index: 0, hash: plaintextHash, encryptedHash, size: 256 }],
        chunkSize: 8388608,
        createdAt: Date.now()
      }

      const toB64 = (b: Uint8Array) => sodium.to_base64(b, sodium.base64_variants.ORIGINAL)

      const manifestBytes = new TextEncoder().encode(JSON.stringify(manifest))
      const manifestNonce = sodium.randombytes_buf(24)
      const manifestCiphertext = sodium.crypto_aead_xchacha20poly1305_ietf_encrypt(
        manifestBytes,
        null,
        null,
        manifestNonce,
        fileKey
      )

      const wrappedNonce = sodium.randombytes_buf(24)
      const wrappedKey = sodium.crypto_aead_xchacha20poly1305_ietf_encrypt(
        fileKey,
        null,
        null,
        wrappedNonce,
        vaultKey
      )

      const signingKeypair = sodium.crypto_sign_keypair()

      const signaturePayload: Record<string, unknown> = {
        encryptedManifest: toB64(manifestCiphertext),
        manifestNonce: toB64(manifestNonce),
        encryptedFileKey: toB64(wrappedKey),
        keyNonce: toB64(wrappedNonce)
      }
      const manifestSignature = signPayload(
        signaturePayload,
        CBOR_FIELD_ORDER.ATTACHMENT_MANIFEST,
        signingKeypair.privateKey
      )

      const encManifest = {
        encryptedManifest: toB64(manifestCiphertext),
        manifestNonce: toB64(manifestNonce),
        encryptedFileKey: toB64(wrappedKey),
        keyNonce: toB64(wrappedNonce),
        manifestSignature: toB64(manifestSignature),
        signerDeviceId: 'device-1'
      }

      const responses = new Map<string, { status: number; body?: unknown; binary?: Uint8Array }>()
      responses.set('GET /attachments/att-1/manifest', { status: 200, body: encManifest })
      responses.set('GET /attachments/chunks/', { status: 200, binary: encryptedWithNonce })

      const mockFetch = createMockFetch(responses)
      const deps: AttachmentSyncDeps = {
        getAccessToken: vi.fn().mockResolvedValue('test-token'),
        getVaultKey: vi.fn().mockResolvedValue(vaultKey),
        getSigningKeys: vi.fn().mockResolvedValue({
          secretKey: signingKeypair.privateKey,
          publicKey: signingKeypair.publicKey,
          deviceId: 'device-1'
        }),
        getDevicePublicKey: vi.fn().mockResolvedValue(signingKeypair.publicKey),
        getSyncServerUrl: () => 'http://localhost:8787',
        fetchFn: mockFetch
      }

      const service = new AttachmentSyncService(deps)
      const targetPath = path.join(tmpDir, 'downloaded.txt')

      const result = await service.downloadAttachment('att-1', targetPath)

      expect(result.filePath).toBe(targetPath)
      expect(result.manifest.id).toBe('att-1')

      const downloaded = await import('node:fs/promises').then((m) => m.readFile(targetPath))
      expect(downloaded.equals(plaintext)).toBe(true)
    })
  })

  describe('downloadAttachment into a directory (embedded attachments)', () => {
    function buildDownloadFixture(filename: string): {
      deps: AttachmentSyncDeps
      mockFetch: ReturnType<typeof vi.fn>
      plaintext: Buffer
    } {
      const vaultKey = generateFileKey()
      const fileKey = generateFileKey()

      const plaintext = Buffer.alloc(256, 'D')
      const plaintextHash = sodium.to_hex(sodium.crypto_hash_sha256(plaintext))

      const nonce = sodium.randombytes_buf(24)
      const ciphertext = sodium.crypto_aead_xchacha20poly1305_ietf_encrypt(
        plaintext,
        null,
        null,
        nonce,
        fileKey
      )
      const encryptedWithNonce = new Uint8Array(nonce.length + ciphertext.length)
      encryptedWithNonce.set(nonce, 0)
      encryptedWithNonce.set(ciphertext, nonce.length)
      const encryptedHash = sodium.to_hex(sodium.crypto_hash_sha256(encryptedWithNonce))

      const manifest = {
        id: 'att-dir',
        filename,
        mimeType: 'application/pdf',
        size: 256,
        checksum: plaintextHash,
        chunks: [{ index: 0, hash: plaintextHash, encryptedHash, size: 256 }],
        chunkSize: 8388608,
        createdAt: Date.now()
      }

      const toB64 = (b: Uint8Array): string => sodium.to_base64(b, sodium.base64_variants.ORIGINAL)
      const manifestBytes = new TextEncoder().encode(JSON.stringify(manifest))
      const manifestNonce = sodium.randombytes_buf(24)
      const manifestCiphertext = sodium.crypto_aead_xchacha20poly1305_ietf_encrypt(
        manifestBytes,
        null,
        null,
        manifestNonce,
        fileKey
      )
      const wrappedNonce = sodium.randombytes_buf(24)
      const wrappedKey = sodium.crypto_aead_xchacha20poly1305_ietf_encrypt(
        fileKey,
        null,
        null,
        wrappedNonce,
        vaultKey
      )
      const signingKeypair = sodium.crypto_sign_keypair()
      const signaturePayload: Record<string, unknown> = {
        encryptedManifest: toB64(manifestCiphertext),
        manifestNonce: toB64(manifestNonce),
        encryptedFileKey: toB64(wrappedKey),
        keyNonce: toB64(wrappedNonce)
      }
      const manifestSignature = signPayload(
        signaturePayload,
        CBOR_FIELD_ORDER.ATTACHMENT_MANIFEST,
        signingKeypair.privateKey
      )
      const encManifest = {
        encryptedManifest: toB64(manifestCiphertext),
        manifestNonce: toB64(manifestNonce),
        encryptedFileKey: toB64(wrappedKey),
        keyNonce: toB64(wrappedNonce),
        manifestSignature: toB64(manifestSignature),
        signerDeviceId: 'device-1'
      }

      const responses = new Map<string, { status: number; body?: unknown; binary?: Uint8Array }>()
      responses.set('GET /attachments/att-dir/manifest', { status: 200, body: encManifest })
      responses.set('GET /attachments/chunks/', { status: 200, binary: encryptedWithNonce })
      const mockFetch = createMockFetch(responses)

      const deps: AttachmentSyncDeps = {
        getAccessToken: vi.fn().mockResolvedValue('test-token'),
        getVaultKey: vi.fn().mockResolvedValue(vaultKey),
        getSigningKeys: vi.fn().mockResolvedValue({
          secretKey: signingKeypair.privateKey,
          publicKey: signingKeypair.publicKey,
          deviceId: 'device-1'
        }),
        getDevicePublicKey: vi.fn().mockResolvedValue(signingKeypair.publicKey),
        getSyncServerUrl: () => 'http://localhost:8787',
        fetchFn: mockFetch
      }

      return { deps, mockFetch, plaintext }
    }

    it('resolves the filename from the decrypted manifest when given a directory', async () => {
      const { deps, plaintext } = buildDownloadFixture('h45j2u-report.pdf')
      const service = new AttachmentSyncService(deps)
      const dir = path.join(tmpDir, 'attachments', 'note-1')

      const result = await service.downloadAttachment('att-dir', dir, { targetIsDir: true })

      expect(result.filePath).toBe(path.join(dir, 'h45j2u-report.pdf'))
      const downloaded = await import('node:fs/promises').then((m) => m.readFile(result.filePath))
      expect(downloaded.equals(plaintext)).toBe(true)
    })

    it('skips the chunk download when the file is already materialized at the same size', async () => {
      const { deps, mockFetch } = buildDownloadFixture('cached.pdf')
      const service = new AttachmentSyncService(deps)
      const dir = path.join(tmpDir, 'attachments', 'note-2')
      await import('node:fs/promises').then(async (m) => {
        await m.mkdir(dir, { recursive: true })
        await m.writeFile(path.join(dir, 'cached.pdf'), Buffer.alloc(256, 'X'))
      })

      const result = await service.downloadAttachment('att-dir', dir, { targetIsDir: true })

      expect(result.filePath).toBe(path.join(dir, 'cached.pdf'))
      const chunkCalls = mockFetch.mock.calls.filter(([url]) =>
        String(url).includes('/attachments/chunks/')
      )
      expect(chunkCalls).toHaveLength(0)
      // existing bytes untouched
      const kept = await import('node:fs/promises').then((m) =>
        m.readFile(path.join(dir, 'cached.pdf'))
      )
      expect(kept.equals(Buffer.alloc(256, 'X'))).toBe(true)
    })

    it('never escapes the target directory even if the manifest filename tries to traverse', async () => {
      const { deps } = buildDownloadFixture('../../evil.pdf')
      const service = new AttachmentSyncService(deps)
      const dir = path.join(tmpDir, 'attachments', 'note-3')

      const result = await service.downloadAttachment('att-dir', dir, { targetIsDir: true })

      expect(path.dirname(result.filePath)).toBe(dir)
      expect(result.filePath.includes('..')).toBe(false)
    })

    it('reports progress to the per-call callback instead of the shared slot', async () => {
      // #given a transfer that passes its own callback while the shared slot is set
      const { deps } = buildDownloadFixture('per-call.pdf')
      const service = new AttachmentSyncService(deps)
      const shared: string[] = []
      const perCall: string[] = []
      service.setProgressCallback((p) => shared.push(p.attachmentId))

      // #when
      await service.downloadAttachment('att-dir', path.join(tmpDir, 'per-call.pdf'), {
        onProgress: (p) => perCall.push(p.attachmentId)
      })

      // #then only the caller that owns this transfer hears about it — a second
      // concurrent download can no longer clobber or silence this one. Both the
      // chunk progress and the terminal event go to the per-call callback.
      expect(new Set(perCall)).toEqual(new Set(['att-dir']))
      expect(perCall.length).toBeGreaterThan(0)
      expect(shared).toEqual([])
    })
  })

  describe('progress tracking', () => {
    it('should track upload progress via callback', async () => {
      const testFile = path.join(tmpDir, 'progress.txt')
      await writeFile(testFile, Buffer.alloc(2048, 'D'))

      const responses = new Map<string, { status: number; body?: unknown; binary?: Uint8Array }>()
      responses.set('POST /attachments/upload/initiate', {
        status: 200,
        body: { sessionId: 'session-p', expiresAt: Date.now() + 3600000 }
      })
      responses.set('GET /attachments/upload/session-p', {
        status: 200,
        body: {
          sessionId: 'session-p',
          attachmentId: '',
          totalSize: 0,
          chunkCount: 1,
          uploadedChunks: [],
          expiresAt: 0
        }
      })
      responses.set('HEAD /attachments/chunks/', { status: 404 })
      responses.set('PUT /attachments/upload/session-p/chunk/', {
        status: 200,
        body: { success: true, uploadedChunks: 1 }
      })
      responses.set('POST /attachments/upload/session-p/complete', {
        status: 200,
        body: { success: true }
      })

      const mockFetch = createMockFetch(responses)
      const deps = createTestDeps(mockFetch)
      const service = new AttachmentSyncService(deps)

      const phases = new Set<string>()
      service.setProgressCallback((p) => phases.add(p.phase))

      await service.uploadAttachment('note-1', testFile)

      expect(phases.has('hashing')).toBe(true)
      expect(phases.has('encrypting')).toBe(true)
      expect(phases.has('uploading')).toBe(true)
    })
  })

  describe('auth guards', () => {
    it('should throw when no access token', async () => {
      const mockFetch = createMockFetch(new Map())
      const deps = createTestDeps(mockFetch)
      ;(deps.getAccessToken as ReturnType<typeof vi.fn>).mockResolvedValue(null)

      const service = new AttachmentSyncService(deps)
      await expect(service.uploadAttachment('note-1', '/tmp/x')).rejects.toThrow('no access token')
    })

    it('should throw when vault locked', async () => {
      const mockFetch = createMockFetch(new Map())
      const deps = createTestDeps(mockFetch)
      ;(deps.getVaultKey as ReturnType<typeof vi.fn>).mockResolvedValue(null)

      const service = new AttachmentSyncService(deps)
      await expect(service.uploadAttachment('note-1', '/tmp/x')).rejects.toThrow('vault key')
    })

    it('should throw when signing keys unavailable', async () => {
      const mockFetch = createMockFetch(new Map())
      const deps = createTestDeps(mockFetch)
      ;(deps.getSigningKeys as ReturnType<typeof vi.fn>).mockResolvedValue(null)

      const service = new AttachmentSyncService(deps)
      await expect(service.uploadAttachment('note-1', '/tmp/x')).rejects.toThrow('Device keys')
    })
  })

  describe('getUploadProgress / getDownloadProgress', () => {
    it('should return null for unknown sessions', () => {
      const mockFetch = createMockFetch(new Map())
      const deps = createTestDeps(mockFetch)
      const service = new AttachmentSyncService(deps)

      expect(service.getUploadProgress('unknown')).toBeNull()
      expect(service.getDownloadProgress('unknown')).toBeNull()
    })
  })

  describe('cancelUpload', () => {
    it('should remove session from active uploads', async () => {
      const mockFetch = createMockFetch(new Map())
      const deps = createTestDeps(mockFetch)
      const service = new AttachmentSyncService(deps)

      await service.cancelUpload('session-x')
      expect(service.getUploadProgress('session-x')).toBeNull()
    })
  })

  describe('network retry behavior', () => {
    it('should retry uploadChunk on transient NetworkError', async () => {
      const testFile = path.join(tmpDir, 'retry.txt')
      await writeFile(testFile, Buffer.alloc(1024, 'R'))

      let putCallCount = 0
      const fetchFn = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
        const urlStr = typeof url === 'string' ? url : url instanceof URL ? url.toString() : url.url
        const method = init?.method ?? 'GET'

        if (method === 'POST' && urlStr.includes('/initiate')) {
          return new Response(
            JSON.stringify({ sessionId: 'session-retry', expiresAt: Date.now() + 3600000 }),
            { status: 200, headers: { 'Content-Type': 'application/json' } }
          )
        }
        if (method === 'GET' && urlStr.includes('/upload/session-retry')) {
          return new Response(
            JSON.stringify({
              sessionId: 'session-retry',
              attachmentId: '',
              totalSize: 0,
              chunkCount: 1,
              uploadedChunks: [],
              expiresAt: 0
            }),
            { status: 200, headers: { 'Content-Type': 'application/json' } }
          )
        }
        if (method === 'HEAD' && urlStr.includes('/chunks/')) {
          return new Response(null, { status: 404 })
        }
        if (method === 'PUT' && urlStr.includes('/chunk/')) {
          putCallCount++
          if (putCallCount <= 2) {
            throw new TypeError('Failed to fetch')
          }
          return new Response(JSON.stringify({ success: true }), {
            status: 200,
            headers: { 'Content-Type': 'application/json' }
          })
        }
        if (method === 'POST' && urlStr.includes('/complete')) {
          return new Response(JSON.stringify({ success: true }), {
            status: 200,
            headers: { 'Content-Type': 'application/json' }
          })
        }
        return new Response(null, { status: 404 })
      })

      const deps = createTestDeps(fetchFn)
      const service = new AttachmentSyncService(deps)

      // #when
      const result = await service.uploadAttachment('note-1', testFile)

      // #then
      expect(result.attachmentId).toBeTruthy()
      expect(putCallCount).toBeGreaterThanOrEqual(3)
    })

    it('should emit waiting_network phase during retry', async () => {
      const testFile = path.join(tmpDir, 'waiting.txt')
      await writeFile(testFile, Buffer.alloc(512, 'W'))

      let putCallCount = 0
      const fetchFn = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
        const urlStr = typeof url === 'string' ? url : url instanceof URL ? url.toString() : url.url
        const method = init?.method ?? 'GET'

        if (method === 'POST' && urlStr.includes('/initiate')) {
          return new Response(
            JSON.stringify({ sessionId: 'session-wait', expiresAt: Date.now() + 3600000 }),
            { status: 200, headers: { 'Content-Type': 'application/json' } }
          )
        }
        if (method === 'GET' && urlStr.includes('/upload/session-wait')) {
          return new Response(
            JSON.stringify({
              sessionId: 'session-wait',
              attachmentId: '',
              totalSize: 0,
              chunkCount: 1,
              uploadedChunks: [],
              expiresAt: 0
            }),
            { status: 200, headers: { 'Content-Type': 'application/json' } }
          )
        }
        if (method === 'HEAD' && urlStr.includes('/chunks/')) {
          return new Response(null, { status: 404 })
        }
        if (method === 'PUT' && urlStr.includes('/chunk/')) {
          putCallCount++
          if (putCallCount === 1) {
            throw new TypeError('Failed to fetch')
          }
          return new Response(JSON.stringify({ success: true }), {
            status: 200,
            headers: { 'Content-Type': 'application/json' }
          })
        }
        if (method === 'POST' && urlStr.includes('/complete')) {
          return new Response(JSON.stringify({ success: true }), {
            status: 200,
            headers: { 'Content-Type': 'application/json' }
          })
        }
        return new Response(null, { status: 404 })
      })

      const deps = createTestDeps(fetchFn)
      const service = new AttachmentSyncService(deps)

      // #given — collect progress phases
      const phases: string[] = []
      service.setProgressCallback((p) => phases.push(p.phase))

      // #when
      await service.uploadAttachment('note-1', testFile)

      // #then — waiting_network phase should appear before uploading resumes
      expect(phases).toContain('waiting_network')
      expect(phases).toContain('uploading')
    })

    it('should respect AbortSignal during upload', async () => {
      const testFile = path.join(tmpDir, 'abort.txt')
      await writeFile(testFile, Buffer.alloc(1024, 'A'))

      const fetchFn = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
        const urlStr = typeof url === 'string' ? url : url instanceof URL ? url.toString() : url.url
        const method = init?.method ?? 'GET'

        if (method === 'POST' && urlStr.includes('/initiate')) {
          return new Response(
            JSON.stringify({ sessionId: 'session-abort', expiresAt: Date.now() + 3600000 }),
            { status: 200, headers: { 'Content-Type': 'application/json' } }
          )
        }
        if (method === 'GET' && urlStr.includes('/upload/session-abort')) {
          return new Response(
            JSON.stringify({
              sessionId: 'session-abort',
              attachmentId: '',
              totalSize: 0,
              chunkCount: 1,
              uploadedChunks: [],
              expiresAt: 0
            }),
            { status: 200, headers: { 'Content-Type': 'application/json' } }
          )
        }
        if (method === 'HEAD' && urlStr.includes('/chunks/')) {
          return new Response(null, { status: 404 })
        }
        if (method === 'PUT' && urlStr.includes('/chunk/')) {
          throw new TypeError('Failed to fetch')
        }
        return new Response(null, { status: 404 })
      })

      const deps = createTestDeps(fetchFn)
      const service = new AttachmentSyncService(deps)

      // #given — pre-aborted signal
      const controller = new AbortController()
      controller.abort()

      // #when + #then
      await expect(
        service.uploadAttachment('note-1', testFile, undefined, { signal: controller.signal })
      ).rejects.toThrow('aborted')
    })
  })

  describe('active transfer bookkeeping', () => {
    it('tracks an upload while it runs and drops it when the upload fails', async () => {
      const testFile = path.join(tmpDir, 'leak-upload.txt')
      await writeFile(testFile, Buffer.alloc(1024, 'L'))

      let progressDuringUpload: TransferProgress | null = null
      let service: AttachmentSyncService

      const fetchFn = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
        const urlStr = typeof url === 'string' ? url : url instanceof URL ? url.toString() : url.url
        const method = init?.method ?? 'GET'

        if (method === 'POST' && urlStr.includes('/initiate')) {
          return new Response(
            JSON.stringify({ sessionId: 'session-leak', expiresAt: Date.now() + 3600000 }),
            { status: 200, headers: { 'Content-Type': 'application/json' } }
          )
        }
        if (method === 'GET' && urlStr.includes('/upload/session-leak')) {
          return new Response(
            JSON.stringify({
              sessionId: 'session-leak',
              attachmentId: '',
              totalSize: 0,
              chunkCount: 1,
              uploadedChunks: [],
              expiresAt: 0
            }),
            { status: 200, headers: { 'Content-Type': 'application/json' } }
          )
        }
        if (method === 'PUT' && urlStr.includes('/chunk/')) {
          // Sampled mid-transfer: the session must be observable while the
          // chunk is on the wire, otherwise "cleaned up" would be satisfied by
          // never tracking the upload at all.
          progressDuringUpload = service.getUploadProgress('session-leak')
          return new Response('chunk rejected', { status: 500 })
        }
        return new Response(null, { status: 404 })
      })

      service = new AttachmentSyncService(createTestDeps(fetchFn))

      // #when
      await expect(service.uploadAttachment('note-1', testFile)).rejects.toThrow(
        'Failed to upload chunk'
      )

      // #then — tracked with real values while in flight...
      expect(progressDuringUpload).toEqual({
        attachmentId: expect.any(String),
        phase: 'uploading',
        chunksCompleted: 0,
        totalChunks: 1,
        bytesTransferred: 0,
        totalBytes: 1024
      })
      // ...and gone once the upload threw
      expect(service.getUploadProgress('session-leak')).toBeNull()
    })

    it('tracks a download while it runs and drops it when the download fails', async () => {
      const vaultKey = generateFileKey()
      const signingKeypair = sodium.crypto_sign_keypair()
      const { encManifest } = buildSignedManifest({
        attachmentId: 'att-leak',
        filename: 'leak-download.txt',
        plaintext: Buffer.alloc(256, 'D'),
        vaultKey,
        signingKeypair
      })

      let progressDuringDownload: TransferProgress | null = null
      let service: AttachmentSyncService

      const fetchFn = vi.fn(async (url: string | URL | Request) => {
        const urlStr = typeof url === 'string' ? url : url instanceof URL ? url.toString() : url.url

        if (urlStr.includes('/att-leak/manifest')) {
          return new Response(JSON.stringify(encManifest), {
            status: 200,
            headers: { 'Content-Type': 'application/json' }
          })
        }
        if (urlStr.includes('/chunks/')) {
          progressDuringDownload = service.getDownloadProgress('att-leak')
          // 404, not 5xx: chunk transport failures are retried with backoff
          // now (#1829), and this test is about failure bookkeeping, not retry.
          return new Response(null, { status: 404 })
        }
        return new Response(null, { status: 404 })
      })

      service = new AttachmentSyncService(
        createDownloadDeps(fetchFn, vaultKey, signingKeypair.publicKey)
      )

      // #when
      await expect(
        service.downloadAttachment('att-leak', path.join(tmpDir, 'leak-download.txt'))
      ).rejects.toThrow('Failed to download chunk')

      // #then
      expect(progressDuringDownload).toEqual({
        attachmentId: 'att-leak',
        phase: 'downloading',
        chunksCompleted: 0,
        totalChunks: 1,
        bytesTransferred: 0,
        totalBytes: 256
      })
      expect(service.getDownloadProgress('att-leak')).toBeNull()
    })

    it('a failed download does not clear a concurrent live download of the same attachment', async () => {
      const vaultKey = generateFileKey()
      const signingKeypair = sodium.crypto_sign_keypair()
      const { encManifest, encryptedChunk } = buildSignedManifest({
        attachmentId: 'att-shared',
        filename: 'shared.txt',
        plaintext: Buffer.alloc(256, 'S'),
        vaultKey,
        signingKeypair
      })

      const firstReachedChunk = createDeferred()
      const releaseFirst = createDeferred()
      const secondReachedChunk = createDeferred()
      const releaseSecond = createDeferred()
      let chunkCalls = 0

      const fetchFn = vi.fn(async (url: string | URL | Request) => {
        const urlStr = typeof url === 'string' ? url : url instanceof URL ? url.toString() : url.url

        if (urlStr.includes('/att-shared/manifest')) {
          return new Response(JSON.stringify(encManifest), {
            status: 200,
            headers: { 'Content-Type': 'application/json' }
          })
        }
        if (urlStr.includes('/chunks/')) {
          chunkCalls++
          if (chunkCalls === 1) {
            firstReachedChunk.resolve()
            await releaseFirst.promise
            // 404 aborts on the first answer; a 5xx would spend the full
            // #1829 retry budget here and outlive the test's purpose.
            return new Response(null, { status: 404 })
          }
          secondReachedChunk.resolve()
          await releaseSecond.promise
          return new Response(encryptedChunk, {
            status: 200,
            headers: { 'Content-Type': 'application/octet-stream' }
          })
        }
        return new Response(null, { status: 404 })
      })

      const service = new AttachmentSyncService(
        createDownloadDeps(fetchFn, vaultKey, signingKeypair.publicKey)
      )

      // #given — the doomed transfer registers first, then a second transfer
      // for the same attachment overwrites the map entry under the same key
      const doomed = service.downloadAttachment('att-shared', path.join(tmpDir, 'shared-a.txt'))
      await firstReachedChunk.promise
      const live = service.downloadAttachment('att-shared', path.join(tmpDir, 'shared-b.txt'))
      await secondReachedChunk.promise

      // #when — the first transfer fails while the second is still running
      releaseFirst.resolve()
      await expect(doomed).rejects.toThrow('Failed to download chunk')

      // #then — the survivor's progress is untouched
      expect(service.getDownloadProgress('att-shared')).toEqual({
        attachmentId: 'att-shared',
        phase: 'downloading',
        chunksCompleted: 0,
        totalChunks: 1,
        bytesTransferred: 0,
        totalBytes: 256
      })

      releaseSecond.resolve()
      await live
      expect(service.getDownloadProgress('att-shared')).toBeNull()
    })
  })
})

describe('terminal transfer phases', () => {
  const uploadResponses = (
    sessionId: string
  ): Map<string, { status: number; body?: unknown; binary?: Uint8Array }> => {
    const responses = new Map<string, { status: number; body?: unknown; binary?: Uint8Array }>()
    responses.set('POST /attachments/upload/initiate', {
      status: 200,
      body: { sessionId, expiresAt: Date.now() + 3600000 }
    })
    responses.set(`GET /attachments/upload/${sessionId}`, {
      status: 200,
      body: {
        sessionId,
        attachmentId: '',
        totalSize: 0,
        chunkCount: 1,
        uploadedChunks: [],
        expiresAt: 0
      }
    })
    responses.set(`PUT /attachments/upload/${sessionId}/chunk/`, {
      status: 200,
      body: { success: true, uploadedChunks: 1 }
    })
    responses.set(`POST /attachments/upload/${sessionId}/complete`, {
      status: 200,
      body: { success: true }
    })
    return responses
  }

  describe('#given an upload that reported progress #when it finishes', () => {
    it('#then the last event is a completed phase for the same attachmentId', async () => {
      const testFile = path.join(tmpDir, 'terminal-ok.bin')
      await writeFile(testFile, Buffer.alloc(1024, 'A'))

      const service = new AttachmentSyncService(
        createTestDeps(createMockFetch(uploadResponses('session-ok')))
      )
      const events: TransferProgress[] = []
      service.setProgressCallback((p) => events.push({ ...p }))

      const result = await service.uploadAttachment('note-1', testFile)

      expect(events.at(-1)).toEqual({
        attachmentId: result.attachmentId,
        phase: 'completed',
        chunksCompleted: 1,
        totalChunks: 1,
        bytesTransferred: 1024,
        totalBytes: 1024
      })
    })

    it('#then a throw after the first progress event still ends in a failed phase', async () => {
      const testFile = path.join(tmpDir, 'terminal-fail.bin')
      await writeFile(testFile, Buffer.alloc(1024, 'B'))

      // The hashing/encrypting pass has already reported progress by the time
      // the session is initiated, so this is exactly the transfer that used to
      // strand its entry in the renderer.
      const responses = uploadResponses('session-fail')
      responses.set('POST /attachments/upload/initiate', { status: 500, body: { error: 'boom' } })

      const service = new AttachmentSyncService(createTestDeps(createMockFetch(responses)))
      const events: TransferProgress[] = []
      service.setProgressCallback((p) => events.push({ ...p }))

      await expect(service.uploadAttachment('note-1', testFile)).rejects.toThrow(
        'Failed to initiate upload'
      )

      expect(events.at(-1)?.phase).toBe('failed')
      expect(events.at(-1)?.attachmentId).toBe(events[0].attachmentId)
      expect(events.filter((e) => e.phase === 'failed')).toHaveLength(1)
    })

    it('#then a chunk rejection also ends in a failed phase', async () => {
      const testFile = path.join(tmpDir, 'terminal-chunk-fail.bin')
      await writeFile(testFile, Buffer.alloc(1024, 'C'))

      const responses = uploadResponses('session-chunk')
      responses.set('PUT /attachments/upload/session-chunk/chunk/', {
        status: 500,
        body: { error: 'boom' }
      })

      const service = new AttachmentSyncService(createTestDeps(createMockFetch(responses)))
      const events: TransferProgress[] = []
      service.setProgressCallback((p) => events.push({ ...p }))

      await expect(service.uploadAttachment('note-1', testFile)).rejects.toThrow(
        'Failed to upload chunk'
      )

      expect(events.at(-1)?.phase).toBe('failed')
    })
  })

  describe('#given an upload that dies before any progress #when it throws', () => {
    it('#then no terminal event is emitted', async () => {
      const service = new AttachmentSyncService(createTestDeps(createMockFetch(new Map())))
      const events: TransferProgress[] = []
      service.setProgressCallback((p) => events.push({ ...p }))

      await expect(
        service.uploadAttachment('note-1', path.join(tmpDir, 'never-existed.bin'))
      ).rejects.toThrow()

      // Nothing was ever reported, so there is no renderer entry to terminate —
      // a terminal event here would invent an overlay that never existed.
      expect(events).toEqual([])
    })
  })

  describe('#given a download that reported progress #when it fails', () => {
    it('#then the last event is a failed phase', async () => {
      const vaultKey = generateFileKey()
      const signingKeypair = sodium.crypto_sign_keypair()
      // Chunk hashes still match, so the chunk decrypts and reports progress;
      // the whole-file checksum then fails, after the renderer has an entry.
      const { encManifest, encryptedChunk } = buildSignedManifest({
        attachmentId: 'att-terminal-fail',
        filename: 'terminal.txt',
        plaintext: Buffer.alloc(256, 'T'),
        vaultKey,
        signingKeypair,
        checksum: 'f'.repeat(64)
      })

      const fetchFn = vi.fn(async (url: string | URL | Request) => {
        const urlStr = typeof url === 'string' ? url : url instanceof URL ? url.toString() : url.url
        if (urlStr.includes('/att-terminal-fail/manifest')) {
          return new Response(JSON.stringify(encManifest), {
            status: 200,
            headers: { 'Content-Type': 'application/json' }
          })
        }
        if (urlStr.includes('/chunks/')) {
          return new Response(encryptedChunk, {
            status: 200,
            headers: { 'Content-Type': 'application/octet-stream' }
          })
        }
        return new Response(null, { status: 404 })
      })

      const service = new AttachmentSyncService(
        createDownloadDeps(fetchFn, vaultKey, signingKeypair.publicKey)
      )
      const events: TransferProgress[] = []

      await expect(
        service.downloadAttachment('att-terminal-fail', path.join(tmpDir, 'terminal.txt'), {
          onProgress: (p) => events.push({ ...p })
        })
      ).rejects.toThrow('File integrity failure')

      expect(events.map((e) => e.phase)).toEqual(['decrypting', 'failed'])
    })

    it('#then a successful download ends in a completed phase', async () => {
      const vaultKey = generateFileKey()
      const signingKeypair = sodium.crypto_sign_keypair()
      const { encManifest, encryptedChunk } = buildSignedManifest({
        attachmentId: 'att-terminal-ok',
        filename: 'terminal-ok.txt',
        plaintext: Buffer.alloc(256, 'K'),
        vaultKey,
        signingKeypair
      })

      const fetchFn = vi.fn(async (url: string | URL | Request) => {
        const urlStr = typeof url === 'string' ? url : url instanceof URL ? url.toString() : url.url
        if (urlStr.includes('/att-terminal-ok/manifest')) {
          return new Response(JSON.stringify(encManifest), {
            status: 200,
            headers: { 'Content-Type': 'application/json' }
          })
        }
        if (urlStr.includes('/chunks/')) {
          return new Response(encryptedChunk, {
            status: 200,
            headers: { 'Content-Type': 'application/octet-stream' }
          })
        }
        return new Response(null, { status: 404 })
      })

      const service = new AttachmentSyncService(
        createDownloadDeps(fetchFn, vaultKey, signingKeypair.publicKey)
      )
      const events: TransferProgress[] = []

      await service.downloadAttachment(
        'att-terminal-ok',
        path.join(tmpDir, 'terminal-ok-out.txt'),
        { onProgress: (p) => events.push({ ...p }) }
      )

      expect(events.map((e) => e.phase)).toEqual(['decrypting', 'completed'])
    })
  })
})

// ============================================================================
// Streaming download with resume (#1829)
// ============================================================================

describe('AttachmentSyncService — streaming downloads with resume', () => {
  /** A three-chunk attachment ('A'|'B'|'C' blocks) under one manifest fileKey. */
  function buildThreeChunkFixture(
    attachmentId: string,
    opts: {
      /** Forge a WRONG whole-file checksum in the manifest. */ manifestChecksum?: string
    } = {}
  ): {
    encManifest: Record<string, string>
    chunksByEncryptedHash: Map<string, { index: number; encryptedWithNonce: Uint8Array }>
    wholeFileChecksum: string
    plaintexts: Buffer[]
    signerPublicKey: Uint8Array
    vaultKey: Uint8Array
  } {
    const toB64 = (b: Uint8Array): string => sodium.to_base64(b, sodium.base64_variants.ORIGINAL)
    const vaultKey = generateFileKey()
    const fileKey = generateFileKey()

    const chunks: Array<{
      index: number
      encryptedHash: string
      hash: string
      size: number
      encryptedWithNonce: Uint8Array
    }> = []
    const plaintexts: Buffer[] = []

    ;['A', 'B', 'C'].forEach((letter, index) => {
      const plaintext = Buffer.alloc(256, letter)
      plaintexts.push(plaintext)
      const nonce = sodium.randombytes_buf(24)
      const ciphertext = sodium.crypto_aead_xchacha20poly1305_ietf_encrypt(
        plaintext,
        null,
        null,
        nonce,
        fileKey
      )
      const encryptedWithNonce = new Uint8Array(nonce.length + ciphertext.length)
      encryptedWithNonce.set(nonce, 0)
      encryptedWithNonce.set(ciphertext, nonce.length)
      chunks.push({
        index,
        encryptedHash: sodium.to_hex(sodium.crypto_hash_sha256(encryptedWithNonce)),
        hash: sodium.to_hex(sodium.crypto_hash_sha256(plaintext)),
        size: 256,
        encryptedWithNonce
      })
    })

    const wholeFile = Buffer.concat(plaintexts)
    const wholeFileChecksum = sodium.to_hex(sodium.crypto_hash_sha256(wholeFile))

    const manifest = {
      id: attachmentId,
      filename: 'resumable.bin',
      mimeType: 'application/octet-stream',
      size: 768,
      checksum: opts.manifestChecksum ?? wholeFileChecksum,
      chunks: chunks.map(({ index, encryptedHash, hash, size }) => ({
        index,
        encryptedHash,
        hash,
        size
      })),
      chunkSize: 8388608,
      createdAt: Date.now()
    }

    const manifestNonce = sodium.randombytes_buf(24)
    const manifestCiphertext = sodium.crypto_aead_xchacha20poly1305_ietf_encrypt(
      new TextEncoder().encode(JSON.stringify(manifest)),
      null,
      null,
      manifestNonce,
      fileKey
    )
    const keyNonce = sodium.randombytes_buf(24)
    const wrappedKey = sodium.crypto_aead_xchacha20poly1305_ietf_encrypt(
      fileKey,
      null,
      null,
      keyNonce,
      vaultKey
    )
    const signingKeypair = sodium.crypto_sign_keypair()
    const signaturePayload: Record<string, unknown> = {
      encryptedManifest: toB64(manifestCiphertext),
      manifestNonce: toB64(manifestNonce),
      encryptedFileKey: toB64(wrappedKey),
      keyNonce: toB64(keyNonce)
    }
    const manifestSignature = signPayload(
      signaturePayload,
      CBOR_FIELD_ORDER.ATTACHMENT_MANIFEST,
      signingKeypair.privateKey
    )

    return {
      encManifest: {
        ...(signaturePayload as Record<string, string>),
        manifestSignature: toB64(manifestSignature),
        signerDeviceId: 'device-1'
      },
      chunksByEncryptedHash: new Map(
        chunks.map((c) => [
          c.encryptedHash,
          { index: c.index, encryptedWithNonce: c.encryptedWithNonce }
        ])
      ),
      wholeFileChecksum,
      plaintexts,
      signerPublicKey: signingKeypair.publicKey,
      vaultKey
    }
  }

  function makeResumableFetchFn(
    fixture: ReturnType<typeof buildThreeChunkFixture>,
    opts: { failChunkIndexes?: Set<number>; status?: number } = {}
  ): ReturnType<typeof vi.fn> & { chunkFetchCounts: number[] } {
    const chunkFetchCounts = [0, 0, 0]
    const fetchFn = vi.fn(async (url: string | URL | Request) => {
      const urlStr = typeof url === 'string' ? url : url instanceof URL ? url.toString() : url.url

      if (urlStr.includes('/manifest')) {
        return new Response(JSON.stringify(fixture.encManifest), {
          status: 200,
          headers: { 'Content-Type': 'application/json' }
        })
      }
      if (urlStr.includes('/chunks/')) {
        const encryptedHash = urlStr.split('/chunks/')[1]
        const chunk = fixture.chunksByEncryptedHash.get(encryptedHash)
        if (!chunk) return new Response(null, { status: 404 })
        if (opts.failChunkIndexes?.has(chunk.index)) {
          return new Response(null, {
            status: opts.status ?? 500,
            headers: opts.status === 429 ? { 'Retry-After': '1' } : undefined
          })
        }
        chunkFetchCounts[chunk.index]++
        return new Response(chunk.encryptedWithNonce, {
          status: 200,
          headers: { 'Content-Type': 'application/octet-stream' }
        })
      }
      return new Response(null, { status: 404 })
    })
    return Object.assign(fetchFn, { chunkFetchCounts })
  }

  it('a mid-file transport failure keeps landed chunks; the retry fetches only the rest', async () => {
    const fixture = buildThreeChunkFixture('att-resume')
    // Chunk 1 answers 429 once — RateLimitError aborts the attempt instantly
    // (no per-item retry sleep) and IS resumable, so the partial survives.
    let failChunkOne = true
    const fetchFn = makeResumableFetchFn(fixture)
    const inner = fetchFn.getMockImplementation()!
    fetchFn.mockImplementation(async (url: string | URL | Request) => {
      const urlStr = typeof url === 'string' ? url : url instanceof URL ? url.toString() : url.url
      if (failChunkOne && urlStr.includes('/chunks/')) {
        const encryptedHash = urlStr.split('/chunks/')[1]
        const chunk = fixture.chunksByEncryptedHash.get(encryptedHash)
        if (chunk?.index === 1) {
          return new Response(null, { status: 429, headers: { 'Retry-After': '1' } })
        }
      }
      return inner(url)
    })

    const service = new AttachmentSyncService(
      createDownloadDeps(fetchFn, fixture.vaultKey, fixture.signerPublicKey)
    )
    const targetPath = path.join(tmpDir, 'resumed.bin')

    // #when — first attempt dies on chunk 1
    await expect(service.downloadAttachment('att-resume', targetPath)).rejects.toMatchObject({
      name: 'RateLimitError'
    })

    // #then — chunk 0 is safely on disk as the partial, sidecar agrees...
    const partialPath = path.join(tmpDir, '.att-resume.resumed.bin.mrypart')
    const partial = await import('node:fs/promises').then((m) => m.readFile(partialPath))
    expect(partial.equals(fixture.plaintexts[0])).toBe(true)
    const sidecar = JSON.parse(
      await import('node:fs/promises').then((m) => m.readFile(`${partialPath}.json`, 'utf-8'))
    )
    expect(sidecar).toMatchObject({ chunksDone: 1, bytesWritten: 256, chunkCount: 3 })
    // ...and the final file does not exist yet (atomic rename only at the end).
    await expect(import('node:fs/promises').then((m) => m.stat(targetPath))).rejects.toThrow()

    // #when — retry with the transport healthy
    failChunkOne = false
    const result = await service.downloadAttachment('att-resume', targetPath)

    // #then — chunk 0 was NOT re-fetched; only the missing two were.
    expect(fetchFn.chunkFetchCounts).toEqual([1, 1, 1])
    const downloaded = await import('node:fs/promises').then((m) => m.readFile(result.filePath))
    expect(downloaded.equals(Buffer.concat(fixture.plaintexts))).toBe(true)
    // The sidecar is consumed on success.
    await expect(import('node:fs/promises').then((m) => m.stat(partialPath))).rejects.toThrow()
  })

  it('an inconsistent partial+sidecar pair is discarded and the download restarts clean', async () => {
    const fixture = buildThreeChunkFixture('att-stale')
    const fetchFn = makeResumableFetchFn(fixture)

    const service = new AttachmentSyncService(
      createDownloadDeps(fetchFn, fixture.vaultKey, fixture.signerPublicKey)
    )
    const targetPath = path.join(tmpDir, 'stale.bin')
    const partialPath = path.join(tmpDir, '.att-stale.stale.bin.mrypart')

    // #given — a leftover partial whose SIZE disagrees with its sidecar claim
    // (e.g. crash between chunk write and fsync/sidecar update).
    await import('node:fs/promises').then((m) =>
      m.writeFile(partialPath, Buffer.alloc(100, 'X'), { mode: 0o600 })
    )
    await import('node:fs/promises').then((m) =>
      m.writeFile(
        `${partialPath}.json`,
        JSON.stringify({
          version: 1,
          attachmentId: 'att-stale',
          checksum: fixture.wholeFileChecksum,
          chunkCount: 3,
          chunksDone: 1,
          bytesWritten: 256
        }),
        { mode: 0o600 }
      )
    )

    // #when
    const result = await service.downloadAttachment('att-stale', targetPath)

    // #then — every chunk came from the network; result is still exact.
    expect(fetchFn.chunkFetchCounts).toEqual([1, 1, 1])
    const downloaded = await import('node:fs/promises').then((m) => m.readFile(result.filePath))
    expect(downloaded.equals(Buffer.concat(fixture.plaintexts))).toBe(true)
  })

  it('writes each landed chunk straight to disk; nothing waits for a full-file buffer', async () => {
    const fixture = buildThreeChunkFixture('att-stream')
    const targetPath = path.join(tmpDir, 'streamed.bin')
    const partialPath = path.join(tmpDir, '.att-stream.streamed.bin.mrypart')

    // Hold chunk 2's response until we have inspected the disk state.
    let chunkTwoRequested = false
    let releaseChunkTwo: (() => void) | null = null
    const chunkTwoGate = new Promise<void>((resolve) => {
      releaseChunkTwo = resolve
    })
    const fetchFn = vi.fn(async (url: string | URL | Request) => {
      const urlStr = typeof url === 'string' ? url : url instanceof URL ? url.toString() : url.url
      if (urlStr.includes('/manifest')) {
        return new Response(JSON.stringify(fixture.encManifest), {
          status: 200,
          headers: { 'Content-Type': 'application/json' }
        })
      }
      if (urlStr.includes('/chunks/')) {
        const encryptedHash = urlStr.split('/chunks/')[1]
        const entry = fixture.chunksByEncryptedHash.get(encryptedHash)
        if (!entry) return new Response(null, { status: 404 })
        if (entry.index === 2) {
          chunkTwoRequested = true
          await chunkTwoGate
        }
        return new Response(entry.encryptedWithNonce, {
          status: 200,
          headers: { 'Content-Type': 'application/octet-stream' }
        })
      }
      return new Response(null, { status: 404 })
    })

    const service = new AttachmentSyncService(
      createDownloadDeps(fetchFn, fixture.vaultKey, fixture.signerPublicKey)
    )

    const pending = service.downloadAttachment('att-stream', targetPath)
    await vi.waitFor(() => expect(chunkTwoRequested).toBe(true))

    // Mid-flight: chunks 0+1 are decrypted, verified and ALREADY on disk as the
    // partial — they were never held for a whole-file reassembly — while the
    // final destination does not exist yet.
    const partialMidFlight = await import('node:fs/promises').then((m) => m.readFile(partialPath))
    expect(partialMidFlight.equals(Buffer.concat(fixture.plaintexts.slice(0, 2)))).toBe(true)
    const sidecarMidFlight = JSON.parse(
      await import('node:fs/promises').then((m) => m.readFile(`${partialPath}.json`, 'utf-8'))
    )
    expect(sidecarMidFlight).toMatchObject({ chunksDone: 2, bytesWritten: 512 })
    await expect(import('node:fs/promises').then((m) => m.stat(targetPath))).rejects.toThrow()

    releaseChunkTwo!()
    const result = await pending
    const downloaded = await import('node:fs/promises').then((m) => m.readFile(result.filePath))
    expect(downloaded.equals(Buffer.concat(fixture.plaintexts))).toBe(true)
  })

  it('a non-resumable failure wipes the partial so no poisoned bytes survive', async () => {
    const fixture = buildThreeChunkFixture('att-integrity')
    const targetPath = path.join(tmpDir, 'integrity.bin')

    // Chunk 1's hash check fails (its fetch returns chunk 2's bytes) — an
    // integrity failure, which must never be resumed from.
    const entries = [...fixture.chunksByEncryptedHash.values()]
    const chunkTwo = entries.find((c) => c.index === 2)!
    const fetchFn = vi.fn(async (url: string | URL | Request) => {
      const urlStr = typeof url === 'string' ? url : url instanceof URL ? url.toString() : url.url
      if (urlStr.includes('/manifest')) {
        return new Response(JSON.stringify(fixture.encManifest), {
          status: 200,
          headers: { 'Content-Type': 'application/json' }
        })
      }
      if (urlStr.includes('/chunks/')) {
        const encryptedHash = urlStr.split('/chunks/')[1]
        const entry = fixture.chunksByEncryptedHash.get(encryptedHash)
        if (!entry) return new Response(null, { status: 404 })
        const payload = entry.index === 1 ? chunkTwo.encryptedWithNonce : entry.encryptedWithNonce
        return new Response(payload, {
          status: 200,
          headers: { 'Content-Type': 'application/octet-stream' }
        })
      }
      return new Response(null, { status: 404 })
    })

    await expect(
      new AttachmentSyncService(
        createDownloadDeps(fetchFn, fixture.vaultKey, fixture.signerPublicKey)
      ).downloadAttachment('att-integrity', targetPath)
    ).rejects.toThrow(/Chunk integrity failure/)

    // Nothing was left behind for bytes that can never verify.
    const leftovers = await import('node:fs/promises').then((m) => m.readdir(tmpDir))
    expect(leftovers.filter((f) => f.startsWith('.att-integrity'))).toEqual([])
    await expect(import('node:fs/promises').then((m) => m.stat(targetPath))).rejects.toThrow()
  })

  it('chunks each verify but a mismatching whole-file hash fails the download and wipes the partial', async () => {
    // Pins the FINAL assembly check: every chunk passes its own integrity
    // check, so only the whole-file verification stands between a corrupted
    // assembly and being renamed into place as if it were good.
    const fixture = buildThreeChunkFixture('att-whole-hash', {
      manifestChecksum: 'e'.repeat(64)
    })
    const fetchFn = makeResumableFetchFn(fixture)
    const targetPath = path.join(tmpDir, 'whole-hash.bin')

    // #when — all three chunks decrypt + hash-verify; the assembled file then
    // does not match the manifest checksum.
    await expect(
      new AttachmentSyncService(
        createDownloadDeps(fetchFn, fixture.vaultKey, fixture.signerPublicKey)
      ).downloadAttachment('att-whole-hash', targetPath)
    ).rejects.toThrow(/File integrity failure/)

    // #then — no file at the destination, and the partial is gone.
    await expect(import('node:fs/promises').then((m) => m.stat(targetPath))).rejects.toThrow()
    const leftovers = await import('node:fs/promises').then((m) => m.readdir(tmpDir))
    expect(leftovers.filter((f) => f.startsWith('.att-whole-hash'))).toEqual([])
  })

  it('a sidecar with a stale checksum but consistent sizes is discarded; the retry restarts chunk 0', async () => {
    const fixture = buildThreeChunkFixture('att-sidecar')
    const fetchFn = makeResumableFetchFn(fixture)
    const service = new AttachmentSyncService(
      createDownloadDeps(fetchFn, fixture.vaultKey, fixture.signerPublicKey)
    )
    const targetPath = path.join(tmpDir, 'sidecar.bin')
    const partialPath = path.join(tmpDir, '.att-sidecar.sidecar.bin.mrypart')

    // #given — sizes agree perfectly with THIS manifest (256 bytes = 1 chunk),
    // but the checksum names a different manifest: stale bytes that must never
    // be resumed on size alone.
    await import('node:fs/promises').then(async (m) => {
      await m.writeFile(partialPath, Buffer.alloc(256, 'Z'), { mode: 0o600 })
      await m.writeFile(
        `${partialPath}.json`,
        JSON.stringify({
          version: 1,
          attachmentId: 'att-sidecar',
          checksum: 'c'.repeat(64),
          chunkCount: 3,
          chunksDone: 1,
          bytesWritten: 256
        }),
        { mode: 0o600 }
      )
    })

    // #when
    const result = await service.downloadAttachment('att-sidecar', targetPath)

    // #then — nothing was resumed: every chunk came from the network.
    expect(fetchFn.chunkFetchCounts).toEqual([1, 1, 1])
    const downloaded = await import('node:fs/promises').then((m) => m.readFile(result.filePath))
    expect(downloaded.equals(Buffer.concat(fixture.plaintexts))).toBe(true)
  })

  it('a disk-full failure keeps the verified prefix and reports an actionable error', async () => {
    const fixture = buildThreeChunkFixture('att-enospc')
    const fetchFn = makeResumableFetchFn(fixture)
    const service = new AttachmentSyncService(
      createDownloadDeps(fetchFn, fixture.vaultKey, fixture.signerPublicKey)
    )
    const targetPath = path.join(tmpDir, 'enospc.bin')
    const partialPath = path.join(tmpDir, '.att-enospc.enospc.bin.mrypart')

    // #given — the disk fills up as the SECOND chunk is written.
    fsMockState.failWritesAfter = 1

    // #when — ENOSPC mid-write surfaces a localized, actionable message...
    await expect(service.downloadAttachment('att-enospc', targetPath)).rejects.toThrow(
      /disk space/i
    )

    // #then — ...the verified prefix and its sidecar survive for resume...
    const partial = await import('node:fs/promises').then((m) => m.readFile(partialPath))
    expect(partial.equals(fixture.plaintexts[0])).toBe(true)
    const sidecar = JSON.parse(
      await import('node:fs/promises').then((m) => m.readFile(`${partialPath}.json`, 'utf-8'))
    )
    expect(sidecar).toMatchObject({ chunksDone: 1, bytesWritten: 256 })
    await expect(import('node:fs/promises').then((m) => m.stat(targetPath))).rejects.toThrow()

    // #when space returns — the retry resumes at chunk 1 instead of starting
    // over. Chunk 0 is NOT re-fetched (prefix reused); chunk 1 IS, because its
    // bytes never landed — the write failed after a successful fetch.
    fsMockState.failWritesAfter = Number.POSITIVE_INFINITY
    const result = await service.downloadAttachment('att-enospc', targetPath)

    expect(fetchFn.chunkFetchCounts).toEqual([1, 2, 1])
    const downloaded = await import('node:fs/promises').then((m) => m.readFile(result.filePath))
    expect(downloaded.equals(Buffer.concat(fixture.plaintexts))).toBe(true)
  })
})
