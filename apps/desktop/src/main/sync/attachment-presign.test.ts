import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { writeFile, readFile, mkdtemp, rm } from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import sodium from 'libsodium-wrappers-sumo'

vi.mock('electron', () => ({ net: { fetch: vi.fn() } }))

import { AttachmentSyncService, type AttachmentSyncDeps } from './attachments'
import { AttachmentPresigner } from './attachment-presign'
import { generateFileKey } from '../crypto/keys'
import { signPayload } from '../crypto/signatures'
import { CBOR_FIELD_ORDER } from '@memry/contracts/cbor-ordering'

const R2_GET_URL = 'https://r2.example/get/chunk-0'
const WORKER_CHUNK_PATH = '/sync/attachments/chunks/'

interface RecordedCall {
  url: string
  method: string
  headers: Record<string, string>
  body?: Uint8Array | string
}

interface MockRoute {
  match: (url: string, method: string, bodyText: string) => boolean
  respond: (call: RecordedCall) => Response
}

function createRecordingFetch(routes: MockRoute[], calls: RecordedCall[]) {
  return vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url =
      typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
    const method = init?.method ?? 'GET'
    const rawBody = init?.body
    const body =
      rawBody instanceof Uint8Array ? rawBody : typeof rawBody === 'string' ? rawBody : undefined
    const bodyText =
      typeof body === 'string' ? body : Buffer.from(body ?? new Uint8Array()).toString('utf8')
    const headers: Record<string, string> = {}
    if (init?.headers) {
      for (const [k, v] of Object.entries(init.headers as Record<string, string>)) headers[k] = v
    }
    calls.push({ url, method, headers, ...(body !== undefined ? { body } : {}) })

    for (const route of routes) {
      if (route.match(url, method, bodyText)) return route.respond({ url, method, headers, body })
    }
    return new Response(JSON.stringify({ error: `no mock for ${method} ${url}` }), { status: 404 })
  })
}

/** Single-chunk encrypted manifest + its on-the-wire chunk (nonce || ciphertext). */
function buildEncryptedFixture(opts: {
  attachmentId: string
  plaintext: Buffer
  vaultKey: Uint8Array
  signingKeypair: { privateKey: Uint8Array; publicKey: Uint8Array }
}): { encManifest: Record<string, string>; encryptedChunk: Uint8Array; encryptedHash: string } {
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
  const encryptedHash = sodium.to_hex(sodium.crypto_hash_sha256(encryptedChunk))

  const manifest = {
    id: opts.attachmentId,
    filename: 'file.bin',
    mimeType: 'application/octet-stream',
    size: opts.plaintext.length,
    checksum: sodium.to_hex(sodium.crypto_hash_sha256(opts.plaintext)),
    chunks: [
      {
        index: 0,
        hash: sodium.to_hex(sodium.crypto_hash_sha256(opts.plaintext)),
        encryptedHash,
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
    encryptedChunk,
    encryptedHash
  }
}

describe('direct-to-R2 attachment transfers (#1836)', () => {
  let tmpDir: string

  const makeDeps = (
    fetchFn: ReturnType<typeof createRecordingFetch>,
    overrides?: Partial<AttachmentSyncDeps>
  ): AttachmentSyncDeps => ({
    getAccessToken: vi.fn().mockResolvedValue('test-token'),
    getVaultKey: vi.fn().mockResolvedValue(generateFileKey()),
    getSigningKeys: vi.fn().mockResolvedValue(null),
    getDevicePublicKey: vi.fn(),
    getSyncServerUrl: () => 'http://worker.test',
    fetchFn: fetchFn as unknown as typeof globalThis.fetch,
    ...overrides
  })

  beforeEach(async () => {
    await sodium.ready
    tmpDir = await mkdtemp(path.join(os.tmpdir(), 'memry-presign-test-'))
  })

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true })
  })

  describe('downloads', () => {
    it('fetches chunks straight from the presigned URL with no auth headers', async () => {
      const attachmentId = 'att-direct'
      const vaultKey = generateFileKey()
      const keypair = sodium.crypto_sign_keypair()
      const plaintext = Buffer.from('presigned download payload')
      const { encManifest, encryptedChunk, encryptedHash } = buildEncryptedFixture({
        attachmentId,
        plaintext,
        vaultKey,
        signingKeypair: keypair
      })

      const calls: RecordedCall[] = []
      const fetchFn = createRecordingFetch(
        [
          {
            match: (u, m) =>
              m === 'GET' && u.includes(`/sync/attachments/${attachmentId}/manifest`),
            respond: () => new Response(JSON.stringify(encManifest), { status: 200 })
          },
          {
            match: (u, m) => m === 'POST' && u.includes('/sync/attachments/presign-batch'),
            respond: () =>
              new Response(
                JSON.stringify({
                  urls: { [encryptedHash]: R2_GET_URL },
                  expiresAt: Math.floor(Date.now() / 1000) + 300
                }),
                { status: 200 }
              )
          },
          {
            match: (u, m) => m === 'GET' && u.startsWith(R2_GET_URL),
            respond: () =>
              new Response(Buffer.from(encryptedChunk), {
                status: 200,
                headers: { 'Content-Type': 'application/octet-stream' }
              })
          }
        ],
        calls
      )

      const service = new AttachmentSyncService(
        makeDeps(fetchFn, {
          getSigningKeys: vi.fn().mockResolvedValue({
            secretKey: keypair.privateKey,
            publicKey: keypair.publicKey,
            deviceId: 'device-1'
          }),
          getDevicePublicKey: vi.fn().mockResolvedValue(keypair.publicKey),
          getVaultKey: vi.fn().mockResolvedValue(vaultKey)
        })
      )

      const targetPath = path.join(tmpDir, 'out.bin')
      await service.downloadAttachment(attachmentId, targetPath)

      expect(await readFile(targetPath)).toEqual(plaintext)

      // Direct hit: no Worker chunk fetch happened at all.
      expect(calls.some((c) => c.method === 'GET' && c.url.includes(WORKER_CHUNK_PATH))).toBe(false)
      const r2Call = calls.find((c) => c.url.startsWith(R2_GET_URL))
      expect(r2Call).toBeDefined()
      expect(r2Call!.headers['Authorization']).toBeUndefined()
      expect(r2Call!.headers['X-Memry-Vault-Id']).toBeUndefined()
      // The presign call itself went through the Worker WITH auth.
      const presignCall = calls.find((c) => c.url.includes('/presign-batch'))
      expect(presignCall!.headers['Authorization']).toBe('Bearer test-token')
    })

    it('falls back to the proxied path when the server answers 501, and stays proxied', async () => {
      const vaultKey = generateFileKey()
      const keypair = sodium.crypto_sign_keypair()

      const makeFixture = (id: string) =>
        buildEncryptedFixture({
          attachmentId: id,
          plaintext: Buffer.from(`payload-${id}`),
          vaultKey,
          signingKeypair: keypair
        })
      const f1 = makeFixture('att-a')
      const f2 = makeFixture('att-b')

      let presignCount = 0
      const routesFor = (
        id: string,
        fixture: {
          encManifest: Record<string, string>
          encryptedChunk: Uint8Array
          encryptedHash: string
        }
      ): MockRoute[] => [
        {
          match: (u, m) => m === 'POST' && u.includes('/sync/attachments/presign-batch'),
          respond: () => {
            presignCount++
            return new Response('not configured', { status: 501 })
          }
        },
        {
          match: (u, m) => m === 'GET' && u.includes(`/sync/attachments/${id}/manifest`),
          respond: () => new Response(JSON.stringify(fixture.encManifest), { status: 200 })
        },
        {
          // The proxied URL carries the ciphertext hash — scope by it so each
          // attachment's chunk comes from its own fixture.
          match: (u, m) =>
            m === 'GET' && u.includes(WORKER_CHUNK_PATH) && u.includes(fixture.encryptedHash),
          respond: () =>
            new Response(Buffer.from(fixture.encryptedChunk), {
              status: 200,
              headers: { 'Content-Type': 'application/octet-stream' }
            })
        }
      ]

      const calls: RecordedCall[] = []
      const allRoutes: MockRoute[] = []
      const fetchFn = createRecordingFetch(allRoutes, calls)
      allRoutes.push(...routesFor('att-a', f1), ...routesFor('att-b', f2))

      const service = new AttachmentSyncService(
        makeDeps(fetchFn, {
          getSigningKeys: vi.fn().mockResolvedValue({
            secretKey: keypair.privateKey,
            publicKey: keypair.publicKey,
            deviceId: 'device-1'
          }),
          getDevicePublicKey: vi.fn().mockResolvedValue(keypair.publicKey),
          getVaultKey: vi.fn().mockResolvedValue(vaultKey)
        })
      )

      const out1 = path.join(tmpDir, 'a.bin')
      await service.downloadAttachment('att-a', out1)
      expect(await readFile(out1)).toEqual(Buffer.from('payload-att-a'))

      const out2 = path.join(tmpDir, 'b.bin')
      await service.downloadAttachment('att-b', out2)
      expect(await readFile(out2)).toEqual(Buffer.from('payload-att-b'))

      // Definitive unavailability is remembered ACROSS transfers: one probe
      // total, not one per download.
      expect(presignCount).toBe(1)
    })

    it('refreshes an expired/rejected URL exactly once, then finishes via proxy', async () => {
      const attachmentId = 'att-refresh'
      const vaultKey = generateFileKey()
      const keypair = sodium.crypto_sign_keypair()
      const plaintext = Buffer.from('refresh fallback payload')
      const { encManifest, encryptedChunk, encryptedHash } = buildEncryptedFixture({
        attachmentId,
        plaintext,
        vaultKey,
        signingKeypair: keypair
      })

      const calls: RecordedCall[] = []
      let presignCount = 0
      let r2Hits = 0
      const fetchFn = createRecordingFetch(
        [
          {
            match: (u, m) =>
              m === 'GET' && u.includes(`/sync/attachments/${attachmentId}/manifest`),
            respond: () => new Response(JSON.stringify(encManifest), { status: 200 })
          },
          {
            match: (u, m) => m === 'POST' && u.includes('/presign-batch'),
            respond: () => {
              presignCount++
              return new Response(
                JSON.stringify({
                  urls: { [encryptedHash]: `${R2_GET_URL}?attempt=${presignCount}` },
                  expiresAt: Math.floor(Date.now() / 1000) + 300
                }),
                { status: 200 }
              )
            }
          },
          {
            match: (u, m) => m === 'GET' && u.startsWith(R2_GET_URL),
            respond: () => {
              r2Hits++
              // Both the original AND the refreshed URL are rejected: the
              // deployment signs garbage. Proxy must take over.
              return new Response('SignatureDoesNotMatch', { status: 403 })
            }
          },
          {
            match: (u, m) => m === 'GET' && u.includes(WORKER_CHUNK_PATH),
            respond: () =>
              new Response(Buffer.from(encryptedChunk), {
                status: 200,
                headers: { 'Content-Type': 'application/octet-stream' }
              })
          }
        ],
        calls
      )

      const service = new AttachmentSyncService(
        makeDeps(fetchFn, {
          getSigningKeys: vi.fn().mockResolvedValue({
            secretKey: keypair.privateKey,
            publicKey: keypair.publicKey,
            deviceId: 'device-1'
          }),
          getDevicePublicKey: vi.fn().mockResolvedValue(keypair.publicKey),
          getVaultKey: vi.fn().mockResolvedValue(vaultKey)
        })
      )

      const targetPath = path.join(tmpDir, 'refresh.bin')
      await service.downloadAttachment(attachmentId, targetPath)
      expect(await readFile(targetPath)).toEqual(plaintext)

      // Initial batch + exactly ONE refresh; two rejected direct attempts;
      // final bytes came from the proxy.
      expect(presignCount).toBe(2)
      expect(r2Hits).toBe(2)
      expect(calls.some((c) => c.method === 'GET' && c.url.includes(WORKER_CHUNK_PATH))).toBe(true)
    })
  })

  describe('uploads', () => {
    const seedFile = async (contents: string): Promise<string> => {
      const filePath = path.join(tmpDir, 'seed.bin')
      await writeFile(filePath, contents)
      return filePath
    }

    it('PUTs chunks direct to R2 and reports them at complete time', async () => {
      const vaultKey = generateFileKey()
      const keypair = sodium.crypto_sign_keypair()

      let initiatedHashes: string[] = []
      let putUrlByHash: Record<string, string> = {}
      let completeBody: Record<string, unknown> | null = null
      let r2PutHeaders: Record<string, string> | null = null
      let workerChunkPuts = 0

      const calls: RecordedCall[] = []
      const fetchFn = createRecordingFetch(
        [
          {
            match: (u, m) => m === 'POST' && u.includes('/sync/attachments/upload/initiate'),
            respond: ({ body }) => {
              const parsed = JSON.parse(String(body)) as { chunkHashes?: string[] }
              initiatedHashes = parsed.chunkHashes ?? []
              putUrlByHash = Object.fromEntries(
                initiatedHashes.map((h) => [h, `https://r2.example/put/${h.slice(0, 12)}`])
              )
              return new Response(
                JSON.stringify({
                  sessionId: 'session-1',
                  expiresAt: Math.floor(Date.now() / 1000) + 3600,
                  chunkUrls: putUrlByHash,
                  urlExpiresAt: Math.floor(Date.now() / 1000) + 300
                }),
                { status: 201 }
              )
            }
          },
          {
            match: (u, m) => m === 'GET' && u.includes('/sync/attachments/upload/session-1'),
            respond: () =>
              new Response(JSON.stringify({ sessionId: 'session-1', uploadedChunks: [] }), {
                status: 200
              })
          },
          {
            match: (u, m) => m === 'PUT' && u.startsWith('https://r2.example/put/'),
            respond: ({ headers }) => {
              r2PutHeaders = headers
              return new Response(null, { status: 200 })
            }
          },
          {
            match: (u, m) => m === 'PUT' && u.includes('/sync/attachments/upload/session-1/chunk/'),
            respond: () => {
              workerChunkPuts++
              return new Response(JSON.stringify({ success: true, uploadedChunks: 1 }), {
                status: 200
              })
            }
          },
          {
            match: (u, m) => m === 'POST' && u.includes('/complete'),
            respond: ({ body }) => {
              completeBody = JSON.parse(String(body)) as Record<string, unknown>
              return new Response(
                JSON.stringify({ attachment_id: 'att-x', manifest_key: 'mk', size: 10 }),
                { status: 200 }
              )
            }
          }
        ],
        calls
      )

      const service = new AttachmentSyncService(
        makeDeps(fetchFn, {
          getSigningKeys: vi.fn().mockResolvedValue({
            secretKey: keypair.privateKey,
            publicKey: keypair.publicKey,
            deviceId: 'device-1'
          }),
          getDevicePublicKey: vi.fn().mockResolvedValue(keypair.publicKey),
          getVaultKey: vi.fn().mockResolvedValue(vaultKey)
        })
      )

      const filePath = await seedFile('upload me')
      const result = await service.uploadAttachment('note-1', filePath)

      // Initiate carried every ciphertext hash so the server could presign.
      expect(initiatedHashes).toHaveLength(1)
      expect(initiatedHashes[0]).toMatch(/^[a-f0-9]{64}$/)

      // The chunk went straight to R2, unsigned by us, and the proxy stayed idle.
      expect(r2PutHeaders).toBeDefined()
      expect(r2PutHeaders!['Authorization']).toBeUndefined()
      expect(workerChunkPuts).toBe(0)

      // Complete reported the direct chunk with its exact byte count.
      const direct = completeBody!.directChunks as Array<{ i: number; h: string; b: number }>
      expect(direct).toHaveLength(1)
      expect(direct[0]).toEqual({ i: 0, h: initiatedHashes[0], b: expect.any(Number) })
      expect(result.manifest.chunks[0].encryptedHash).toBe(initiatedHashes[0])
    })

    it('keeps the fully proxied flow against a server that issues no URLs', async () => {
      const vaultKey = generateFileKey()
      const keypair = sodium.crypto_sign_keypair()

      let completeBody: Record<string, unknown> | null = null
      let workerChunkPuts = 0
      let r2Puts = 0

      const calls: RecordedCall[] = []
      const fetchFn = createRecordingFetch(
        [
          {
            match: (u, m) => m === 'POST' && u.includes('/sync/attachments/upload/initiate'),
            respond: () =>
              // Old-server shape: no chunkUrls key at all.
              new Response(
                JSON.stringify({
                  sessionId: 'session-old',
                  expiresAt: Math.floor(Date.now() / 1000) + 3600
                }),
                { status: 201 }
              )
          },
          {
            match: (u, m) => m === 'GET' && u.includes('/sync/attachments/upload/session-old'),
            respond: () =>
              new Response(JSON.stringify({ sessionId: 'session-old', uploadedChunks: [] }), {
                status: 200
              })
          },
          {
            match: (u, m) => m === 'PUT' && u.includes('/chunk/'),
            respond: () => {
              workerChunkPuts++
              return new Response(JSON.stringify({ success: true, uploadedChunks: 1 }), {
                status: 200
              })
            }
          },
          {
            match: (u, m) => m === 'PUT' && u.startsWith('https://r2.example/'),
            respond: () => {
              r2Puts++
              return new Response(null, { status: 200 })
            }
          },
          {
            match: (u, m) => m === 'POST' && u.includes('/complete'),
            respond: ({ body }) => {
              completeBody = JSON.parse(String(body)) as Record<string, unknown>
              return new Response(
                JSON.stringify({ attachment_id: 'att-y', manifest_key: 'mk', size: 10 }),
                { status: 200 }
              )
            }
          }
        ],
        calls
      )

      const service = new AttachmentSyncService(
        makeDeps(fetchFn, {
          getSigningKeys: vi.fn().mockResolvedValue({
            secretKey: keypair.privateKey,
            publicKey: keypair.publicKey,
            deviceId: 'device-1'
          }),
          getDevicePublicKey: vi.fn().mockResolvedValue(keypair.publicKey),
          getVaultKey: vi.fn().mockResolvedValue(vaultKey)
        })
      )

      const filePath = await seedFile('legacy flow')
      await service.uploadAttachment('note-1', filePath)

      expect(workerChunkPuts).toBe(1)
      expect(r2Puts).toBe(0)
      expect(completeBody!.directChunks).toBeUndefined()
    })
  })

  describe('AttachmentPresigner availability memory', () => {
    it('stops probing after a definitive 501 but not after transient errors', async () => {
      const calls: RecordedCall[] = []
      let status = 500
      const fetchFn = createRecordingFetch(
        [
          {
            match: (_u, _m) => true,
            respond: () => new Response('x', { status })
          }
        ],
        calls
      )
      const presigner = new AttachmentPresigner({
        getSyncServerUrl: () => 'http://worker.test',
        fetchFn: fetchFn as unknown as typeof globalThis.fetch
      })

      // Transient 5xx: falls back for this batch, stays available.
      status = 500
      await expect(presigner.fetchBatch('t', ['a'.repeat(64)])).resolves.toBeNull()
      expect(presigner.available).toBe(true)

      // Definitive 501: null now AND available flips false (no re-probe).
      status = 501
      await expect(presigner.fetchBatch('t', ['a'.repeat(64)])).resolves.toBeNull()
      expect(presigner.available).toBe(false)
      const probesAfterUnavailable = calls.length
      await expect(presigner.fetchBatch('t', ['a'.repeat(64)])).resolves.toBeNull()
      expect(calls.length).toBe(probesAfterUnavailable)
    })
  })
})
