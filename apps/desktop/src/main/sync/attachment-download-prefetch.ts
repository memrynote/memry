import { ATTACHMENT_MANIFEST_BATCH_CAP, PRESIGN_BATCH_CAP } from '@memry/contracts/blob-api'
import { createLogger } from '../lib/logger'
import type { PresignedUrlWindow } from './attachment-presign'
import type { EncryptedAttachmentManifest } from './attachments'

const log = createLogger('AttachmentDownloadPrefetch')

/** An old server has no batch route; stop asking it for this long. */
const UNSUPPORTED_COOLDOWN_MS = 10 * 60_000
/** A prefetched manifest no download claimed in this long is dropped. */
const PREFETCH_TTL_MS = 10 * 60_000

interface Prefetched {
  manifest: EncryptedAttachmentManifest
  /** Ciphertext hashes of its chunks, so one presign call covers it too. */
  chunkHashes: string[]
  fetchedAt: number
}

export interface AttachmentDownloadPrefetchDeps {
  /** The chunk hashes inside a verified, decrypted manifest. */
  chunkHashesOf: (manifest: EncryptedAttachmentManifest) => Promise<string[]>
}

/**
 * Shares download metadata across queued attachment downloads (#5329). A fresh
 * device downloads every attachment, and one manifest GET plus one presign call
 * per attachment made 2,128 of a 2,767-request bootstrap. The first download
 * that needs a manifest fetches it together with the manifests of up to 99
 * downloads queued behind it, and the first one that needs chunk URLs presigns
 * the chunks of those downloads as well.
 */
export class AttachmentDownloadPrefetch {
  private readonly prefetched = new Map<string, Prefetched>()
  private readonly inflight = new Map<string, Promise<void>>()
  private unsupportedUntil = 0
  private shared: PresignedUrlWindow | null = null
  private sharedFetch: Promise<PresignedUrlWindow | null> | null = null

  constructor(private readonly deps: AttachmentDownloadPrefetchDeps) {}

  /**
   * The manifest of `attachmentId`, fetched in one batch with the `upcoming`
   * downloads. Null means the caller fetches it alone: no other download is
   * waiting, the server is old, the batch failed, or the server has no manifest
   * for this id (the single GET then reports the 404).
   */
  async takeManifest(
    attachmentId: string,
    upcoming: (() => string[]) | undefined,
    postBatch: (attachmentIds: string[]) => Promise<Response>
  ): Promise<EncryptedAttachmentManifest | null> {
    if (!this.prefetched.has(attachmentId) && !this.inflight.has(attachmentId) && upcoming) {
      this.startBatch(attachmentId, upcoming(), postBatch)
    }
    await this.inflight.get(attachmentId)
    const entry = this.prefetched.get(attachmentId)
    this.prefetched.delete(attachmentId)
    if (!entry || Date.now() - entry.fetchedAt > PREFETCH_TTL_MS) return null
    return entry.manifest
  }

  /**
   * A presigned window holding `hash`. `pendingHashes` (this transfer's
   * remaining chunks) go first, so the transfer gets the URLs it got before;
   * the chunks of prefetched downloads fill the rest of the call's 1024.
   */
  async presignWindow(
    hash: string,
    pendingHashes: string[],
    fetchWindow: (chunkHashes: string[]) => Promise<PresignedUrlWindow | null>
  ): Promise<PresignedUrlWindow | null> {
    while (this.sharedFetch) await this.sharedFetch
    if (this.shared && Date.now() < this.shared.expiresAtMs && this.shared.urls.has(hash)) {
      return this.shared
    }
    const hashes = new Set(pendingHashes.slice(0, PRESIGN_BATCH_CAP))
    for (const entry of this.prefetched.values()) {
      for (const h of entry.chunkHashes) {
        if (hashes.size >= PRESIGN_BATCH_CAP) break
        hashes.add(h)
      }
    }
    const fetch = fetchWindow([...hashes])
    this.sharedFetch = fetch
    try {
      const window = await fetch
      if (window) this.shared = window
      return window
    } finally {
      this.sharedFetch = null
    }
  }

  private startBatch(
    first: string,
    upcoming: string[],
    postBatch: (attachmentIds: string[]) => Promise<Response>
  ): void {
    if (Date.now() < this.unsupportedUntil) return
    const ids = new Set([first])
    for (const id of upcoming) {
      if (ids.size >= ATTACHMENT_MANIFEST_BATCH_CAP) break
      if (!this.prefetched.has(id) && !this.inflight.has(id)) ids.add(id)
    }
    if (ids.size < 2) return
    const batch = this.fetchBatch([...ids], postBatch)
    for (const id of ids) this.inflight.set(id, batch)
  }

  private async fetchBatch(
    ids: string[],
    postBatch: (attachmentIds: string[]) => Promise<Response>
  ): Promise<void> {
    try {
      const response = await postBatch(ids)
      if (response.status === 404 || response.status === 405) {
        this.unsupportedUntil = Date.now() + UNSUPPORTED_COOLDOWN_MS
        log.info('server has no manifest batch route; fetching manifests one by one')
        return
      }
      if (!response.ok) {
        log.warn('manifest batch failed; fetching these manifests one by one', {
          status: response.status,
          count: ids.length
        })
        return
      }
      // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- response.json returns any; the asserted type is the wire contract (AttachmentManifestBatchResponseSchema), and each manifest is signature-verified before use
      const body = (await response.json()) as {
        manifests: Record<string, EncryptedAttachmentManifest>
      }
      const fetchedAt = Date.now()
      this.pruneExpired(fetchedAt)
      for (const id of ids) {
        const manifest = body.manifests[id]
        if (!manifest) continue
        let chunkHashes: string[] = []
        try {
          chunkHashes = await this.deps.chunkHashesOf(manifest)
        } catch (err) {
          // The download verifies the manifest again and reports the failure.
          log.debug('prefetched manifest did not verify', { attachmentId: id, err })
        }
        this.prefetched.set(id, { manifest, chunkHashes, fetchedAt })
      }
    } catch (err) {
      log.warn('manifest batch failed; fetching these manifests one by one', {
        count: ids.length,
        err
      })
    } finally {
      for (const id of ids) this.inflight.delete(id)
    }
  }

  private pruneExpired(now: number): void {
    for (const [id, entry] of this.prefetched) {
      if (now - entry.fetchedAt > PREFETCH_TTL_MS) this.prefetched.delete(id)
    }
  }
}
