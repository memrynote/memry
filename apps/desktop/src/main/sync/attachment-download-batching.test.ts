import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import sodium from 'libsodium-wrappers-sumo'

import { AttachmentSyncService } from './attachments'
import { DownloadPacer, DownloadQueue } from './download-queue'
import { generateFileKey } from '../crypto/keys'
import { signPayload } from '../crypto/signatures'
import { CBOR_FIELD_ORDER } from '@memry/contracts/cbor-ordering'

const SERVER = 'http://localhost:8787'
const R2 = 'https://r2.test/'

let tmpDir: string

beforeEach(async () => {
  // oxlint-disable-next-line import/no-named-as-default-member -- libsodium is a CJS default-export object and sibling crypto tests mock it as default-only
  await sodium.ready
  tmpDir = await mkdtemp(path.join(os.tmpdir(), 'memry-batching-'))
})

afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true })
})

// oxlint-disable-next-line import/no-named-as-default-member -- libsodium is a CJS default-export object and sibling crypto tests mock it as default-only
const toB64 = (b: Uint8Array): string => sodium.to_base64(b, sodium.base64_variants.ORIGINAL)
// oxlint-disable-next-line import/no-named-as-default-member -- libsodium is a CJS default-export object and sibling crypto tests mock it as default-only
const sha256 = (b: Uint8Array): string => sodium.to_hex(sodium.crypto_hash_sha256(b))

function encrypt(plaintext: Uint8Array, key: Uint8Array): Uint8Array {
  const nonce = sodium.randombytes_buf(24)
  const ciphertext = sodium.crypto_aead_xchacha20poly1305_ietf_encrypt(
    plaintext,
    null,
    null,
    nonce,
    key
  )
  const framed = new Uint8Array(nonce.length + ciphertext.length)
  framed.set(nonce, 0)
  framed.set(ciphertext, nonce.length)
  return framed
}

/** A server holding attachments of the given chunk counts, with presigning on. */
function fakeServer(chunkCounts: Record<string, number>) {
  const vaultKey = generateFileKey()
  const signer = sodium.crypto_sign_keypair()
  const manifests = new Map<string, Record<string, string>>()
  const chunks = new Map<string, Uint8Array>()
  const files = new Map<string, Buffer>()

  for (const [id, count] of Object.entries(chunkCounts)) {
    const fileKey = generateFileKey()
    const parts = Array.from({ length: count }, (_, i) => Buffer.from(`${id}:${i}`))
    const refs = parts.map((plaintext, index) => {
      const framed = encrypt(plaintext, fileKey)
      chunks.set(sha256(framed), framed)
      return {
        index,
        hash: sha256(plaintext),
        encryptedHash: sha256(framed),
        size: plaintext.length
      }
    })
    const whole = Buffer.concat(parts)
    files.set(id, whole)
    const manifest = {
      id,
      filename: `${id}.bin`,
      mimeType: 'application/octet-stream',
      size: whole.length,
      checksum: sha256(whole),
      chunks: refs,
      chunkSize: 8 * 1024 * 1024,
      createdAt: Date.now()
    }
    const manifestNonce = sodium.randombytes_buf(24)
    const keyNonce = sodium.randombytes_buf(24)
    const signed = {
      encryptedManifest: toB64(
        sodium.crypto_aead_xchacha20poly1305_ietf_encrypt(
          new TextEncoder().encode(JSON.stringify(manifest)),
          null,
          null,
          manifestNonce,
          fileKey
        )
      ),
      manifestNonce: toB64(manifestNonce),
      encryptedFileKey: toB64(
        sodium.crypto_aead_xchacha20poly1305_ietf_encrypt(fileKey, null, null, keyNonce, vaultKey)
      ),
      keyNonce: toB64(keyNonce)
    }
    const signature = signPayload(signed, CBOR_FIELD_ORDER.ATTACHMENT_MANIFEST, signer.privateKey)
    manifests.set(id, { ...signed, manifestSignature: toB64(signature), signerDeviceId: 'd1' })
  }

  const counts = { manifestGet: 0, manifestBatch: 0, presign: 0, direct: 0, proxied: 0 }
  const fetchFn = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    if (url.startsWith(R2)) {
      counts.direct++
      return new Response(Buffer.from(chunks.get(url.slice(R2.length))!))
    }
    const route = url.slice(`${SERVER}/sync/attachments/`.length)
    if (route === 'manifests/batch') {
      counts.manifestBatch++
      const { attachmentIds } = JSON.parse(init?.body as string) as { attachmentIds: string[] }
      return Response.json({
        manifests: Object.fromEntries(attachmentIds.map((id) => [id, manifests.get(id)]))
      })
    }
    if (route === 'presign-batch') {
      counts.presign++
      const { chunkHashes } = JSON.parse(init?.body as string) as { chunkHashes: string[] }
      return Response.json({
        urls: Object.fromEntries(chunkHashes.map((h) => [h, `${R2}${h}`])),
        expiresAt: Math.floor(Date.now() / 1000) + 300
      })
    }
    if (route.startsWith('chunks/')) {
      counts.proxied++
      return new Response(Buffer.from(chunks.get(route.slice('chunks/'.length))!))
    }
    counts.manifestGet++
    return Response.json(manifests.get(route.slice(0, -'/manifest'.length)))
  }

  const service = new AttachmentSyncService({
    getAccessToken: async () => 'token',
    getVaultKey: async () => vaultKey,
    getSigningKeys: async () => ({
      secretKey: signer.privateKey.slice(),
      publicKey: signer.publicKey,
      deviceId: 'd1'
    }),
    getDevicePublicKey: async () => signer.publicKey,
    getSyncServerUrl: () => SERVER,
    getVaultPath: () => tmpDir,
    fetchFn
  })
  return { service, counts, files }
}

/** Every attachment eagerly through the real queue, as the pull fan-out does. */
async function downloadAll(server: ReturnType<typeof fakeServer>): Promise<void> {
  const queue = new DownloadQueue(
    server.service.downloadAttachment.bind(server.service),
    undefined,
    new DownloadPacer(1_000_000)
  )
  await Promise.all(
    [...server.files].map(async ([attachmentId, bytes]) => {
      const targetPath = path.join(tmpDir, `${attachmentId}.bin`)
      await queue.enqueue({ ownerId: 'note-1', attachmentId, targetPath, source: 'eager' })
      expect(Buffer.compare(await readFile(targetPath), bytes)).toBe(0)
    })
  )
  queue.dispose()
}

describe('attachment downloads sharing manifest and presign calls (#5329)', () => {
  it('three downloads that start together make one manifest call and one presign call', async () => {
    const server = fakeServer({ a: 1, b: 1, c: 1 })

    await downloadAll(server)

    expect(server.counts).toEqual({
      manifestGet: 0,
      manifestBatch: 1,
      presign: 1,
      direct: 3,
      proxied: 0
    })
  })

  it('sends no chunk of a large file through the proxy when the batch fills the presign cap', async () => {
    // a's presign call fills its 1024 with a, v1, v2, v3 and the first 123 of v4's 300 chunks.
    const order = ['a', 'v1', 'v2', 'v3', 'v4']
    const server = fakeServer({ a: 1, v1: 300, v2: 300, v3: 300, v4: 300 })

    for (const [i, attachmentId] of order.entries()) {
      const targetPath = path.join(tmpDir, `${attachmentId}.bin`)
      await server.service.downloadAttachment(attachmentId, targetPath, {
        upcoming: () => order.slice(i + 1)
      })
      expect(Buffer.compare(await readFile(targetPath), server.files.get(attachmentId)!)).toBe(0)
    }

    expect(server.counts.proxied).toBe(0)
    expect(server.counts.direct).toBe(1201)
    expect(server.counts.manifestBatch).toBe(1)
  }, 60_000)

  it('downloads 1,064 attachments with ceil(1064/100) manifest calls and at most as many presign calls', async () => {
    const server = fakeServer(
      Object.fromEntries(Array.from({ length: 1064 }, (_, i) => [`att-${i}`, 1]))
    )

    await downloadAll(server)

    expect(server.counts.manifestGet).toBe(0)
    expect(server.counts.manifestBatch).toBe(11)
    expect(server.counts.proxied).toBe(0)
    expect(server.counts.presign).toBeLessThanOrEqual(11)
  }, 120_000)
})
