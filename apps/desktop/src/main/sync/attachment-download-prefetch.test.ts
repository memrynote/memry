import { describe, expect, it, vi } from 'vitest'
import { AttachmentDownloadPrefetch } from './attachment-download-prefetch'
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

  it('leaves out of a batch the downloads that already took their manifest', async () => {
    const { batches, postBatch, prefetch } = server()

    await prefetch.takeManifest('a', () => ['b'], postBatch)
    await prefetch.takeManifest('b', () => [], postBatch)
    // a is in flight again (a retry) and listed first, as the queue lists it.
    await prefetch.takeManifest('c', () => ['a', 'b', 'd'], postBatch)

    expect(batches).toEqual([
      ['a', 'b'],
      ['c', 'd']
    ])
  })

  it('stops asking a server without the batch route, so each download GETs its manifest', async () => {
    const prefetch = new AttachmentDownloadPrefetch({ chunkHashesOf: async () => [] })
    const postBatch = vi.fn(async () => new Response('Not Found', { status: 404 }))

    expect(await prefetch.takeManifest('a', () => ['b', 'c'], postBatch)).toBeNull()
    expect(await prefetch.takeManifest('b', () => ['c'], postBatch)).toBeNull()

    expect(postBatch).toHaveBeenCalledTimes(1)
  })
})
