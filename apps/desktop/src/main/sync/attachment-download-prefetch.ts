import { ATTACHMENT_MANIFEST_BATCH_CAP, PRESIGN_BATCH_CAP } from '@memry/contracts/blob-api'
import { createLogger } from '../lib/logger'
import type { PresignedUrlWindow } from './attachment-presign'
import type { EncryptedAttachmentManifest } from './attachments'

const log = createLogger('AttachmentDownloadPrefetch')

/** An old server has no batch route; stop asking it for this long. */
const UNSUPPORTED_COOLDOWN_MS = 10 * 60_000
/** Prefetched manifests, taken ids and unarmed hashes older than this are dropped. */
const PREFETCH_TTL_MS = 10 * 60_000

interface PresignFetch {
  hashes: Set<string>
  done: Promise<void>
}

export interface AttachmentDownloadPrefetchDeps {
  /** The chunk hashes inside a verified, decrypted manifest. */
  chunkHashesOf: (manifest: EncryptedAttachmentManifest) => Promise<string[]>
}

/**
 * Shares download metadata across queued attachment downloads (#5329). A fresh
 * device downloads every attachment, and one manifest GET plus one presign call
 * per attachment made 2,128 of a 2,767-request bootstrap.
 *
 * The first download that needs a manifest fetches it together with the
 * manifests of up to 99 downloads queued behind it. Presigned chunk URLs live in
 * one cache keyed by chunk hash. A chunk with no live URL arms a presign call
 * over the caller's own uncovered chunks first, then over the chunks of other
 * downloads that have no URL yet, up to 1024. Every call adds to the cache.
 */
export class AttachmentDownloadPrefetch {
  private readonly prefetched = new Map<
    string,
    { manifest: EncryptedAttachmentManifest; fetchedAt: number }
  >()
  private readonly inflight = new Map<string, Promise<void>>()
  /** Ids a download took a manifest for; a later batch leaves them out. */
  private readonly taken = new Map<string, number>()
  /**
   * Chunk hashes of batched downloads no call has asked for with a 200 answer
   * yet, with when they were added.
   */
  private readonly unarmed = new Map<string, number>()
  private readonly urls = new Map<string, { url: string; expiresAtMs: number }>()
  private readonly presignFetches = new Set<PresignFetch>()
  private unsupportedUntil = 0

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
    this.taken.set(attachmentId, Date.now())
    if (!entry || Date.now() - entry.fetchedAt > PREFETCH_TTL_MS) return null
    return entry.manifest
  }

  /**
   * A live presigned URL for chunk `hash`, or null when presigning failed and
   * the caller takes the proxied path. `pendingHashes` are the caller's chunks
   * still to download; the call that arms `hash` covers all of them it can.
   */
  async presignedUrl(
    hash: string,
    pendingHashes: string[],
    fetchWindow: (chunkHashes: string[]) => Promise<PresignedUrlWindow | null>
  ): Promise<string | null> {
    const cached = this.cachedUrl(hash)
    if (cached) return cached
    const running = [...this.presignFetches].find((f) => f.hashes.has(hash))
    if (running) {
      await running.done
      const armed = this.cachedUrl(hash)
      if (armed) return armed
    }

    this.pruneExpired(Date.now())
    const hashes = new Set([hash])
    for (const h of [...pendingHashes, ...this.unarmed.keys()]) {
      if (hashes.size >= PRESIGN_BATCH_CAP) break
      if (!this.covered(h)) hashes.add(h)
    }
    const fetch: PresignFetch = {
      hashes,
      done: (async () => {
        const window = await fetchWindow([...hashes])
        if (!window) return
        for (const [h, url] of window.urls) {
          this.urls.set(h, { url, expiresAtMs: window.expiresAtMs })
        }
        // A 200 answer settles every hash it was asked. One it leaves out is a
        // chunk the vault does not hold, so other downloads stop offering it;
        // its own download asks once more, then takes the proxy.
        for (const h of hashes) this.unarmed.delete(h)
      })()
    }
    this.presignFetches.add(fetch)
    try {
      await fetch.done
    } finally {
      this.presignFetches.delete(fetch)
    }
    return this.cachedUrl(hash)
  }

  /** Drops a URL the store rejected, so the next lookup presigns it again. */
  forget(hash: string): void {
    this.urls.delete(hash)
  }

  private cachedUrl(hash: string): string | null {
    const entry = this.urls.get(hash)
    if (!entry) return null
    if (Date.now() < entry.expiresAtMs) return entry.url
    this.urls.delete(hash)
    return null
  }

  private covered(hash: string): boolean {
    if (this.cachedUrl(hash)) return true
    for (const f of this.presignFetches) if (f.hashes.has(hash)) return true
    return false
  }

  private startBatch(
    first: string,
    upcoming: string[],
    postBatch: (attachmentIds: string[]) => Promise<Response>
  ): void {
    if (Date.now() < this.unsupportedUntil) return
    this.pruneExpired(Date.now())
    const ids = new Set([first])
    for (const id of upcoming) {
      if (ids.size >= ATTACHMENT_MANIFEST_BATCH_CAP) break
      if (!this.prefetched.has(id) && !this.inflight.has(id) && !this.taken.has(id)) ids.add(id)
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
      // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- response.json returns any; each manifest is signature-verified before use, so a wrong shape fails there
      const body = (await response.json()) as {
        manifests: Record<string, EncryptedAttachmentManifest>
      }
      const fetchedAt = Date.now()
      for (const id of ids) {
        const manifest = body.manifests[id]
        if (!manifest) continue
        this.prefetched.set(id, { manifest, fetchedAt })
        try {
          for (const h of await this.deps.chunkHashesOf(manifest)) this.unarmed.set(h, fetchedAt)
        } catch (err) {
          // The download verifies the manifest again and reports the failure.
          log.debug('prefetched manifest did not verify', { attachmentId: id, err })
        }
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
    for (const [id, at] of this.taken) if (now - at > PREFETCH_TTL_MS) this.taken.delete(id)
    for (const [h, at] of this.unarmed) if (now - at > PREFETCH_TTL_MS) this.unarmed.delete(h)
    for (const [h, entry] of this.urls) if (now >= entry.expiresAtMs) this.urls.delete(h)
  }
}
