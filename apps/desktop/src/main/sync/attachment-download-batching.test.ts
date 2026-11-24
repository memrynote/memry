import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import sodium from 'libsodium-wrappers-sumo'
import Database from 'better-sqlite3'
import { drizzle } from 'drizzle-orm/better-sqlite3'

import { AttachmentSyncService } from './attachments'
import { DownloadPacer, DownloadQueue } from './download-queue'
import { generateFileKey } from '../crypto/keys'
import { signPayload } from '../crypto/signatures'
import { runMigrations } from '../database/migrate'
import { CBOR_FIELD_ORDER } from '@memry/contracts/cbor-ordering'
import {
  MISSING_PROBE_LIMIT,
  isDownloadAbandoned,
  markDownloadFailed,
  pruneUnresolvableReferences
} from '@memry/sync-client/attachment-download-state'
import type { DrizzleDb } from '@memry/sync-client/item-handlers/types'

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

/**
 * A server holding attachments of the given chunk counts, with presigning on.
 * A 200 presign answer leaves out the chunks of the `noUrlFor` attachments, as
 * the real server does for a chunk the vault does not hold, and the proxy
 * answers 404 for them. The first presign call answers `failPresignWith`.
 * `servedAs` maps a requested id to the attachment whose manifest the server
 * answers with instead, on the single GET and under the batch key.
 */
function fakeServer(
  chunkCounts: Record<string, number>,
  {
    noUrlFor = [],
    failPresignWith,
    servedAs = new Map<string, string>()
  }: { noUrlFor?: string[]; failPresignWith?: number; servedAs?: Map<string, string> } = {}
) {
  const vaultKey = generateFileKey()
  const signer = sodium.crypto_sign_keypair()
  const manifests = new Map<string, Record<string, string>>()
  const chunks = new Map<string, Uint8Array>()
  const files = new Map<string, Buffer>()
  const chunkHashes = new Map<string, string[]>()

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
    chunkHashes.set(
      id,
      refs.map((ref) => ref.encryptedHash)
    )
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

  const unsigned = new Set(noUrlFor.flatMap((id) => chunkHashes.get(id)!))
  const presignRequests: string[][] = []
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
        manifests: Object.fromEntries(
          attachmentIds.map((id) => [id, manifests.get(servedAs.get(id) ?? id)])
        )
      })
    }
    if (route === 'presign-batch') {
      counts.presign++
      const requested = (JSON.parse(init?.body as string) as { chunkHashes: string[] }).chunkHashes
      presignRequests.push(requested)
      if (failPresignWith && counts.presign === 1) {
        return new Response(null, { status: failPresignWith })
      }
      return Response.json({
        urls: Object.fromEntries(
          requested.filter((h) => !unsigned.has(h)).map((h) => [h, `${R2}${h}`])
        ),
        expiresAt: Math.floor(Date.now() / 1000) + 300
      })
    }
    if (route.startsWith('chunks/')) {
      counts.proxied++
      const hash = route.slice('chunks/'.length)
      if (unsigned.has(hash)) return new Response(null, { status: 404 })
      return new Response(Buffer.from(chunks.get(hash)!))
    }
    counts.manifestGet++
    const id = route.slice(0, -'/manifest'.length)
    return Response.json(manifests.get(servedAs.get(id) ?? id))
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
  return { service, counts, files, chunkHashes, presignRequests }
}

/** One attachment outside the queue; `upcoming` are the ids the queue would start next. */
async function downloadOne(
  server: ReturnType<typeof fakeServer>,
  attachmentId: string,
  upcoming: string[] = []
): Promise<void> {
  const targetPath = path.join(tmpDir, `${attachmentId}.bin`)
  await server.service.downloadAttachment(attachmentId, targetPath, { upcoming: () => upcoming })
  expect(Buffer.compare(await readFile(targetPath), server.files.get(attachmentId)!)).toBe(0)
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

  it('proxies a chunk a 200 presign answer leaves out and offers it to no other presign call', async () => {
    const server = fakeServer({ a: 1, b: 1, c: 1 }, { noUrlFor: ['b'] })
    const [ha, hb, hc] = ['a', 'b', 'c'].map((id) => server.chunkHashes.get(id)![0])

    // a's manifest batch carries b, so a's presign call asks for b's chunk too and gets no URL.
    await downloadOne(server, 'a', ['b'])
    // c downloads alone, so its presign call holds only its own chunk.
    await downloadOne(server, 'c')
    // b's own download asks once more, then takes the proxy, which answers 404.
    await expect(
      server.service.downloadAttachment('b', path.join(tmpDir, 'b.bin'), { upcoming: () => [] })
    ).rejects.toThrow(`Failed to download chunk ${hb}`)

    expect(server.presignRequests).toEqual([[ha, hb], [hc], [hb]])
    expect(server.counts).toMatchObject({ direct: 2, proxied: 1 })
  })

  it.each([429, 503])(
    'offers the batched chunks to the next presign call after a %i presign answer',
    async (status) => {
      const server = fakeServer({ a: 1, b: 1, c: 1 }, { failPresignWith: status })
      const [ha, hb, hc] = ['a', 'b', 'c'].map((id) => server.chunkHashes.get(id)![0])

      // a's manifest batch carries b; the presign call for both fails, so a takes the proxy.
      await downloadOne(server, 'a', ['b'])
      // c downloads alone, and its call still carries the chunks no 200 answer covered.
      await downloadOne(server, 'c')
      await downloadOne(server, 'b')

      expect(server.presignRequests).toEqual([
        [ha, hb],
        [hc, ha, hb]
      ])
      expect(server.counts).toMatchObject({ presign: 2, direct: 2, proxied: 1 })
    }
  )

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

describe('a manifest that names another attachment (#5652)', () => {
  const noTraffic = { manifestGet: 0, manifestBatch: 0, presign: 0, direct: 0, proxied: 0 }

  it('refuses the single GET answer before any chunk request or write, and downloads once the server answers right', async () => {
    const servedAs = new Map([['b', 'a']])
    const server = fakeServer({ a: 1, b: 1 }, { servedAs })
    const targetPath = path.join(tmpDir, 'b.bin')

    await expect(server.service.downloadAttachment('b', targetPath)).rejects.toThrow(
      'Manifest names attachment a, not b'
    )

    expect(server.counts).toEqual({ ...noTraffic, manifestGet: 1 })
    expect(await readdir(tmpDir)).toEqual([])

    servedAs.clear()
    await server.service.downloadAttachment('b', targetPath)
    expect(Buffer.compare(await readFile(targetPath), server.files.get('b')!)).toBe(0)
  })

  it('refuses a batch answer under another attachment key before any chunk request or write', async () => {
    const server = fakeServer({ a: 1, b: 1, c: 1 }, { servedAs: new Map([['b', 'c']]) })
    await server.service.downloadAttachment('a', path.join(tmpDir, 'a.bin'), {
      upcoming: () => ['b']
    })
    const afterA = { ...noTraffic, manifestBatch: 1, presign: 1, direct: 1 }
    expect(server.counts).toEqual(afterA)

    await expect(
      server.service.downloadAttachment('b', path.join(tmpDir, 'b.bin'))
    ).rejects.toThrow('Manifest names attachment c, not b')

    expect(server.counts).toEqual(afterA)
    expect(await readdir(tmpDir)).toEqual(['a.bin'])
  })

  it('counts the refusal as transient, so the reference is never abandoned or pruned', async () => {
    const server = fakeServer({ a: 1, b: 1 }, { servedAs: new Map([['b', 'a']]) })
    const refusal = await server.service
      .downloadAttachment('b', path.join(tmpDir, 'b.bin'))
      .then(() => null)
      .catch((err: unknown) => err)
    expect(refusal).toBeInstanceOf(Error)

    const dbPath = path.join(tmpDir, 'data.db')
    runMigrations(dbPath)
    const sqlite = new Database(dbPath)
    try {
      const db = drizzle(sqlite) as unknown as DrizzleDb
      for (let i = 0; i <= MISSING_PROBE_LIMIT; i++) {
        expect(markDownloadFailed(db, 'note-1', 'b', refusal)).toBe('transient')
      }
      expect(isDownloadAbandoned(db, 'note-1', 'b')).toBe(false)
      expect(pruneUnresolvableReferences(db, 'note-1', ['b'])).toEqual(['b'])
    } finally {
      sqlite.close()
    }
  })
})
