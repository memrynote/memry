/**
 * Server chunk holds for canvas image assets (#3022, protocol 14 §14.8).
 *
 * A canvas that shows an image it did not upload (a dedup hit, a duplicate, a
 * conflict copy) holds that image's chunks before the canvas is pushed, under
 * a holder id derived per (canvas, image). Every device derives the same id
 * from the vault key, so holding and releasing are idempotent across devices,
 * and the server sees only an opaque id.
 *
 * Electron-free: deps are injected, as in `attachment-dereference.ts`.
 */

import sodium from 'libsodium-wrappers-sumo'

import { createLogger } from '../../lib/logger'

const log = createLogger('CanvasAssetHolds')

const HOLDER_DOMAIN = 'memry/canvas-asset-hold/v1'
// The server caps a request at 64 holders (ChunkHoldRequestSchema).
const HOLDERS_PER_REQUEST = 64

export interface ChunkHoldDeps {
  getAccessToken(): Promise<string | null>
  getSyncServerUrl(): string
  getVaultId(): string
  getVaultKey(): Promise<Uint8Array | null>
  fetchFn?: typeof fetch
}

export interface AssetHold {
  contentHash: string
  chunkHashes: string[]
}

/**
 * - `ok`: every image not in `missing` is held.
 * - `unsupported`: the server predates holds (404); nothing was held.
 * - `failed`: no token, no vault key, offline, or a server error.
 */
export type HoldOutcome =
  { status: 'ok'; missing: Set<string> } | { status: 'unsupported' } | { status: 'failed' }

/** BLAKE2b-256 keyed by the vault key over `domain \0 canvasId \0 contentHash`, hex. */
export function canvasAssetHolderId(
  vaultKey: Uint8Array,
  canvasId: string,
  contentHash: string
): string {
  const input = sodium.from_string(`${HOLDER_DOMAIN}\0${canvasId}\0${contentHash}`)
  return sodium.to_hex(sodium.crypto_generichash(32, input, vaultKey))
}

async function post(
  deps: ChunkHoldDeps,
  path: string,
  body: unknown
): Promise<{ status: number; json?: unknown }> {
  const token = await deps.getAccessToken()
  if (!token) return { status: 0 }
  const fetchImpl = deps.fetchFn ?? fetch
  try {
    const response = await fetchImpl(`${deps.getSyncServerUrl()}/sync${path}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
        'X-Memry-Vault-Id': deps.getVaultId()
      },
      body: JSON.stringify(body)
    })
    if (!response.ok) return { status: response.status }
    return { status: response.status, json: await response.json() }
  } catch (err) {
    log.warn('chunk hold request threw', { path, err })
    return { status: 0 }
  }
}

/** Holds each image's chunks for one canvas. `missing` names images by content hash. */
export async function holdCanvasAssetChunks(
  canvasId: string,
  holds: AssetHold[],
  deps: ChunkHoldDeps
): Promise<HoldOutcome> {
  if (holds.length === 0) return { status: 'ok', missing: new Set() }
  await sodium.ready
  const vaultKey = await deps.getVaultKey()
  if (!vaultKey) return { status: 'failed' }

  const byHolder = new Map(
    holds.map((hold) => [canvasAssetHolderId(vaultKey, canvasId, hold.contentHash), hold])
  )
  const entries = [...byHolder].map(([holderId, hold]) => ({
    holderId,
    chunkHashes: hold.chunkHashes
  }))
  const missing = new Set<string>()
  for (let i = 0; i < entries.length; i += HOLDERS_PER_REQUEST) {
    const res = await post(deps, '/attachments/holds', {
      holds: entries.slice(i, i + HOLDERS_PER_REQUEST)
    })
    if (res.status === 404) return { status: 'unsupported' }
    if (res.status !== 200) {
      log.warn('chunk hold failed', { status: res.status })
      return { status: 'failed' }
    }
    for (const holderId of (res.json as { missing?: string[] }).missing ?? []) {
      const hold = byHolder.get(holderId)
      if (hold) missing.add(hold.contentHash)
    }
  }
  return { status: 'ok', missing }
}

/**
 * Releases the holds of these (canvas, image) pairs. Idempotent on the server.
 * A server that predates holds (404) has none to release, so that is `ok`.
 */
export async function releaseCanvasAssetHolds(
  canvasId: string,
  contentHashes: string[],
  deps: ChunkHoldDeps
): Promise<{ ok: boolean }> {
  if (contentHashes.length === 0) return { ok: true }
  await sodium.ready
  const vaultKey = await deps.getVaultKey()
  if (!vaultKey) return { ok: false }

  const holderIds = [...new Set(contentHashes)].map((hash) =>
    canvasAssetHolderId(vaultKey, canvasId, hash)
  )
  for (let i = 0; i < holderIds.length; i += HOLDERS_PER_REQUEST) {
    const res = await post(deps, '/attachments/holds/release', {
      holderIds: holderIds.slice(i, i + HOLDERS_PER_REQUEST)
    })
    if (res.status === 404) return { ok: true }
    if (res.status !== 200) {
      log.warn('chunk hold release failed', { status: res.status })
      return { ok: false }
    }
  }
  return { ok: true }
}
