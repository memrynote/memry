/**
 * Server dereference client for externalized canvas image assets (M5 GC).
 *
 * POSTs the chunk hashes of assets no longer referenced by any canvas so the
 * server can decrement its ref_count and reclaim storage. Never throws — a
 * 404 (server not yet deployed), missing token, or network error must never
 * break a canvas save/delete, so every failure degrades to `{ok:false}`.
 *
 * Electron-free: deps are injected (mirrors the main/sync deps-injection
 * pattern) and the sync server URL is resolved lazily inside the call, not
 * at module load, per the http-client lazy-URL-resolution gotcha.
 */

import { createLogger } from '../../lib/logger'

const log = createLogger('CanvasAssetDereference')

export interface DereferenceDeps {
  getAccessToken(): Promise<string | null>
  getSyncServerUrl(): string
  getVaultId(): string
  fetchFn?: typeof fetch
}

/**
 * POST /sync/attachments/dereference to decrement server ref_count for the
 * given chunk hashes.
 */
export async function dereferenceChunks(
  chunkHashes: string[],
  deps: DereferenceDeps
): Promise<{ ok: boolean; status: number }> {
  if (chunkHashes.length === 0) return { ok: true, status: 200 }

  const token = await deps.getAccessToken()
  if (!token) {
    log.warn('no access token, skipping chunk dereference', { count: chunkHashes.length })
    return { ok: false, status: 0 }
  }

  const url = `${deps.getSyncServerUrl()}/sync/attachments/dereference`
  const fetchImpl = deps.fetchFn ?? fetch

  try {
    const response = await fetchImpl(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
        'X-Memry-Vault-Id': deps.getVaultId()
      },
      body: JSON.stringify({ chunkHashes })
    })

    if (!response.ok) {
      log.warn('dereference request failed', { status: response.status })
      return { ok: false, status: response.status }
    }

    return { ok: true, status: response.status }
  } catch (err) {
    log.warn('dereference request threw', err)
    return { ok: false, status: 0 }
  }
}
