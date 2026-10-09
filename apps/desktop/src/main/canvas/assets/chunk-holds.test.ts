import { beforeAll, describe, expect, it } from 'vitest'
import sodium from 'libsodium-wrappers-sumo'

import {
  canvasAssetHolderId,
  holdCanvasAssetChunks,
  releaseCanvasAssetHolds,
  type ChunkHoldDeps
} from './chunk-holds'

const HASH = 'c'.repeat(64)

function deps(status: number, body: unknown = {}): ChunkHoldDeps & { requests: unknown[] } {
  const requests: unknown[] = []
  return {
    requests,
    getAccessToken: async () => 'token',
    getSyncServerUrl: () => 'http://sync.test',
    getVaultId: () => 'vault-1',
    getVaultKey: async () => new Uint8Array(32).fill(7),
    fetchFn: async (_url, init) => {
      requests.push(JSON.parse(String(init?.body)))
      return Response.json(body, { status })
    }
  }
}

beforeAll(async () => {
  await sodium.ready
})

// #3022: every device names the same (canvas, image) holder, so a hold or a
// release from any of them is the same row on the server.
describe('canvasAssetHolderId', () => {
  it('is the same for the same vault, canvas and image, and differs otherwise', () => {
    const key = new Uint8Array(32).fill(7)
    const id = canvasAssetHolderId(key, 'canvas-1', HASH)

    expect(id).toMatch(/^[a-f0-9]{64}$/)
    expect(canvasAssetHolderId(new Uint8Array(32).fill(7), 'canvas-1', HASH)).toBe(id)
    expect(canvasAssetHolderId(key, 'canvas-2', HASH)).not.toBe(id)
    expect(canvasAssetHolderId(key, 'canvas-1', 'd'.repeat(64))).not.toBe(id)
    expect(canvasAssetHolderId(new Uint8Array(32).fill(8), 'canvas-1', HASH)).not.toBe(id)
  })
})

describe('against a server', () => {
  it('maps the missing holders back to their images', async () => {
    const key = new Uint8Array(32).fill(7)
    const missingId = canvasAssetHolderId(key, 'canvas-1', HASH)
    const outcome = await holdCanvasAssetChunks(
      'canvas-1',
      [
        { contentHash: HASH, chunkHashes: ['a'.repeat(64)] },
        { contentHash: 'd'.repeat(64), chunkHashes: ['b'.repeat(64)] }
      ],
      deps(200, { missing: [missingId] })
    )
    expect(outcome).toEqual({ status: 'ok', missing: new Set([HASH]) })
  })

  it('reports a server without holds as unsupported, and has nothing to release there', async () => {
    const hold = [{ contentHash: HASH, chunkHashes: ['a'.repeat(64)] }]
    expect(await holdCanvasAssetChunks('canvas-1', hold, deps(404))).toEqual({
      status: 'unsupported'
    })
    expect(await releaseCanvasAssetHolds('canvas-1', [HASH], deps(404))).toEqual({ ok: true })
  })

  it('fails on a server error so the caller retries', async () => {
    const hold = [{ contentHash: HASH, chunkHashes: ['a'.repeat(64)] }]
    expect(await holdCanvasAssetChunks('canvas-1', hold, deps(503))).toEqual({
      status: 'failed',
      retryable: true,
      httpStatus: 503
    })
    expect(await releaseCanvasAssetHolds('canvas-1', [HASH], deps(503))).toEqual({ ok: false })
  })

  it('marks a rate limit retryable and a rejected request final', async () => {
    const hold = [{ contentHash: HASH, chunkHashes: ['a'.repeat(64)] }]
    expect(await holdCanvasAssetChunks('canvas-1', hold, deps(429))).toMatchObject({
      retryable: true
    })
    expect(await holdCanvasAssetChunks('canvas-1', hold, deps(400))).toMatchObject({
      retryable: false
    })
  })
})
