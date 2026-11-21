import { describe, expect, it, vi } from 'vitest'
import { AttachmentDownloadPrefetch } from './attachment-download-prefetch'
import type { PresignedUrlWindow } from './attachment-presign'
import type { EncryptedAttachmentManifest } from './attachments'

/** A stand-in manifest whose "chunk hash" is derived from the attachment id. */
const manifestOf = (id: string): EncryptedAttachmentManifest => ({
  encryptedManifest: id,
  manifestNonce: '',
  encryptedFileKey: '',
  keyNonce: '',
  manifestSignature: '',
  signerDeviceId: 'device-1'
})

function server() {
  const batches: string[][] = []
  const postBatch = vi.fn(async (ids: string[]) => {
    batches.push(ids)
    return Response.json({ manifests: Object.fromEntries(ids.map((id) => [id, manifestOf(id)])) })
  })
  const prefetch = new AttachmentDownloadPrefetch({
    chunkHashesOf: async (m) => [`hash-${m.encryptedManifest}`]
  })
  return { batches, postBatch, prefetch }
}

describe('AttachmentDownloadPrefetch', () => {
  it('fetches the manifests of 250 queued downloads in ceil(250/100) calls', async () => {
    const { batches, postBatch, prefetch } = server()
    const queued = Array.from({ length: 250 }, (_, i) => `att-${i}`)

    for (const [i, id] of queued.entries()) {
      const manifest = await prefetch.takeManifest(id, () => queued.slice(i + 1), postBatch)
      expect(manifest?.encryptedManifest).toBe(id)
    }

    expect(batches.map((b) => b.length)).toEqual([100, 100, 50])
  })

  it('arms one presign window for every prefetched download', async () => {
    const { postBatch, prefetch } = server()
    const queued = ['a', 'b', 'c']
    const presigned: string[][] = []
    const fetchWindow = async (hashes: string[]): Promise<PresignedUrlWindow> => {
      presigned.push(hashes)
      return {
        urls: new Map(hashes.map((h) => [h, `https://r2/${h}`])),
        expiresAtMs: Date.now() + 60_000
      }
    }

    for (const [i, id] of queued.entries()) {
      await prefetch.takeManifest(id, () => queued.slice(i + 1), postBatch)
      const window = await prefetch.presignWindow(`hash-${id}`, [`hash-${id}`], fetchWindow)
      expect(window?.urls.get(`hash-${id}`)).toBe(`https://r2/hash-${id}`)
    }

    expect(presigned).toEqual([['hash-a', 'hash-b', 'hash-c']])
  })

  it('stops asking a server without the batch route, so each download GETs its manifest', async () => {
    const prefetch = new AttachmentDownloadPrefetch({ chunkHashesOf: async () => [] })
    const postBatch = vi.fn(async () => new Response('Not Found', { status: 404 }))

    expect(await prefetch.takeManifest('a', () => ['b', 'c'], postBatch)).toBeNull()
    expect(await prefetch.takeManifest('b', () => ['c'], postBatch)).toBeNull()

    expect(postBatch).toHaveBeenCalledTimes(1)
  })
})
