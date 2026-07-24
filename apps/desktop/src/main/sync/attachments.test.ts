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

beforeEach(async () => {
  await sodium.ready
  tmpDir = await mkdtemp(path.join(os.tmpdir(), 'memry-attach-test-'))
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
})
