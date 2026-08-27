import { sha256 } from '@noble/hashes/sha2.js'
import { bytesToHex } from '@noble/hashes/utils.js'
import type { SyncHttpClient } from '@memry/sync-client/adapters'
import { CLIENT_HEADER } from '@memry/sync-client/pull'
import {
  decryptAttachmentManifest,
  encryptAttachmentManifest,
  type AttachmentChunkRef,
  type AttachmentManifest,
  type EncryptedAttachmentManifest,
  type SyncPushCryptoProvider
} from '@memry/sync-client/push'
import type { VaultDb } from '../db/index'
import { createLogger } from '../lib/logger'
import { createMobileAttachmentStore } from './attachment-store'

const log = createLogger('Attachments')

/**
 * Attachment transfer on mobile (T072/T073).
 *
 * Bytes live in the sandbox (never as DB blobs — the data-model's
 * store-of-record rule), covered by the NSFileProtection entitlement on the
 * whole sandbox. What this module adds on top of the byte store is the part
 * that is genuinely mobile: **lazy** download, defaulting to Wi-Fi only, with
 * a per-item override — a phone must not spend a cellular plan rendering a
 * note the user only scrolled past.
 *
 * The chunk framing, manifest signature and integrity checks mirror desktop's
 * exactly, because both shells read the same R2 objects.
 */

const CHUNK_SIZE = 8 * 1024 * 1024
/** `nonce || ciphertext`; the nonce is the first 24 bytes of every chunk. */
const NONCE_LEN = 24

export type AttachmentAvailability = 'ready' | 'pending' | 'missing'

/**
 * The outcome of naming an attachment without downloading it.
 *
 * `gone` and `unavailable` are kept apart because the caller turns one into a
 * permanent verdict and the other into a retry.
 */
export type PeekResult =
  { status: 'named'; filename: string } | { status: 'unavailable' } | { status: 'gone' }

export interface AttachmentRecord {
  itemId: string
  localPath: string | null
  /** Manifest filename; the key a note-body reference resolves against. */
  filename: string | null
  mimeType: string | null
  downloadedAt: number | null
  /** Per-item override of the Wi-Fi-only default. */
  wifiOnly: boolean
  pinned: boolean
  remoteSize: number | null
}

export interface AttachmentTransferDeps {
  db: VaultDb
  http: SyncHttpClient
  crypto: SyncPushCryptoProvider
  vaultId: string
  accessToken: () => string
  clientHeaderValue: string
  vaultKey: () => Uint8Array | null
  signing: () => { secretKey: Uint8Array; deviceId: string } | null
  resolveDeviceKey: (deviceId: string) => Promise<Uint8Array | null>
  /** True on a metered connection; drives the Wi-Fi-only default. */
  isMetered: () => Promise<boolean>
}

export function sha256Hex(bytes: Uint8Array): string {
  return bytesToHex(sha256(bytes))
}

export class AttachmentTransfer {
  private readonly store = createMobileAttachmentStore()
  /** In-flight downloads, so two blocks pointing at one file fetch it once. */
  private inFlight = new Map<string, Promise<AttachmentAvailability>>()

  constructor(private readonly deps: AttachmentTransferDeps) {}

  async getRecord(attachmentId: string): Promise<AttachmentRecord | null> {
    const row = await this.deps.db.getFirstAsync<{
      item_id: string
      local_path: string | null
      downloaded_at: number | null
      wifi_only: number
      pinned: number
      remote_size: number | null
      filename: string | null
      mime_type: string | null
    }>('SELECT * FROM attachments WHERE item_id = ?', [attachmentId])
    if (!row) return null
    return {
      itemId: row.item_id,
      localPath: row.local_path,
      filename: row.filename,
      mimeType: row.mime_type,
      downloadedAt: row.downloaded_at,
      wifiOnly: row.wifi_only === 1,
      pinned: row.pinned === 1,
      remoteSize: row.remote_size
    }
  }

  /**
   * Learn an attachment's filename WITHOUT downloading it.
   *
   * A note's body references a file by PATH; sync addresses a blob by id, and
   * only the manifest carries the name that links them. Downloading a
   * candidate just to read its name means rendering one picture pulls every
   * attachment in the note — on a phone, on the user's data plan. The manifest
   * is a single small object, so identification costs one request per
   * candidate and the bytes are fetched only for the one that matches.
   *
   * Cached in the same row `ensureLocal` writes, so it is learned once.
   */
  async peekFilename(attachmentId: string): Promise<PeekResult> {
    const known = await this.getRecord(attachmentId)
    if (known?.filename) return { status: 'named', filename: known.filename }

    const vaultKey = this.deps.vaultKey()
    // Locked, not absent: reporting "gone" here would retire the image for the
    // rest of the session even though the file is perfectly fine.
    if (!vaultKey) return { status: 'unavailable' }

    try {
      const encrypted = await this.json<EncryptedAttachmentManifest>(
        'GET',
        `/sync/attachments/${attachmentId}/manifest`
      )
      const signerKey = await this.deps.resolveDeviceKey(encrypted.signerDeviceId)
      if (!signerKey) return { status: 'unavailable' }

      const { manifest } = await decryptAttachmentManifest(
        this.deps.crypto,
        encrypted,
        vaultKey,
        signerKey
      )
      await this.deps.db.runAsync(
        `INSERT INTO attachments (item_id, remote_size, filename, mime_type)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(item_id) DO UPDATE SET
           remote_size = excluded.remote_size,
           filename = excluded.filename,
           mime_type = excluded.mime_type`,
        [attachmentId, manifest.size, manifest.filename, manifest.mimeType]
      )
      return { status: 'named', filename: manifest.filename }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      log.debug('Manifest peek failed', { attachmentId, error: message })
      // Only a 404 means the blob is really gone. Everything else — offline, a
      // 500, a token that needs refreshing — is transient, and calling it gone
      // makes the caller's `missing` verdict permanent for the session.
      return /\b404\b/.test(message) ? { status: 'gone' } : { status: 'unavailable' }
    }
  }

  /** Flip the per-item override; the next `ensureLocal` honours it. */
  async setWifiOnly(attachmentId: string, wifiOnly: boolean): Promise<void> {
    await this.deps.db.runAsync(
      `INSERT INTO attachments (item_id, wifi_only) VALUES (?, ?)
       ON CONFLICT(item_id) DO UPDATE SET wifi_only = excluded.wifi_only`,
      [attachmentId, wifiOnly ? 1 : 0]
    )
  }

  /**
   * Resolve an attachment to a local file, downloading if policy allows.
   *
   * `pending` is a normal answer, not a failure: on cellular with the default
   * policy the bytes are simply not fetched yet, and the editor shows a
   * placeholder with a fetch action rather than a broken image.
   */
  async ensureLocal(
    attachmentId: string,
    options: { force?: boolean } = {}
  ): Promise<AttachmentAvailability> {
    if (await this.store.exists(this.deps.vaultId, attachmentId)) return 'ready'

    const record = await this.getRecord(attachmentId)
    if (!options.force) {
      const wifiOnly = record?.wifiOnly ?? true
      if (wifiOnly && (await this.deps.isMetered())) return 'pending'
    }

    let pending = this.inFlight.get(attachmentId)
    if (!pending) {
      pending = this.download(attachmentId).finally(() => this.inFlight.delete(attachmentId))
      this.inFlight.set(attachmentId, pending)
    }
    return pending
  }

  private async download(attachmentId: string): Promise<AttachmentAvailability> {
    const vaultKey = this.deps.vaultKey()
    if (!vaultKey) return 'pending'

    try {
      const encrypted = await this.json<EncryptedAttachmentManifest>(
        'GET',
        `/sync/attachments/${attachmentId}/manifest`
      )
      const signerKey = await this.deps.resolveDeviceKey(encrypted.signerDeviceId)
      if (!signerKey) {
        // An unknown signer is not a corrupt file — the device list is just
        // stale. Reporting `pending` keeps the placeholder and lets the next
        // open, after a device refresh, succeed.
        log.warn('Unknown manifest signer; leaving the attachment pending', { attachmentId })
        return 'pending'
      }

      const { manifest, fileKey } = await decryptAttachmentManifest(
        this.deps.crypto,
        encrypted,
        vaultKey,
        signerKey
      )

      let plaintext: Uint8Array
      try {
        plaintext = await this.fetchChunks(manifest, fileKey)
      } finally {
        // Same rule as every other crypto path in this change: the unwrapped
        // key does not outlive the operation that needed it.
        fileKey.fill(0)
      }
      if (sha256Hex(plaintext) !== manifest.checksum) {
        throw new Error(`File integrity failure for ${attachmentId}`)
      }

      const { path } = await this.store.writeBytes(this.deps.vaultId, attachmentId, plaintext)
      // The filename is how a note's `attachments/<noteId>/<file>` reference
      // finds this blob — desktop writes the file under exactly this name, so
      // recording it is what makes the two shells agree (migration 0003).
      await this.deps.db.runAsync(
        `INSERT INTO attachments (item_id, local_path, downloaded_at, remote_size, filename, mime_type)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(item_id) DO UPDATE SET
           local_path = excluded.local_path,
           downloaded_at = excluded.downloaded_at,
           remote_size = excluded.remote_size,
           filename = excluded.filename,
           mime_type = excluded.mime_type`,
        [attachmentId, path, Date.now(), manifest.size, manifest.filename, manifest.mimeType]
      )
      return 'ready'
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      // A 404 means the blob is genuinely gone; anything else is transient and
      // the next open retries.
      const missing = /\b404\b/.test(message)
      log.warn('Attachment download failed', { attachmentId, error: message, missing })
      return missing ? 'missing' : 'pending'
    }
  }

  private async fetchChunks(
    manifest: AttachmentManifest,
    fileKey: Uint8Array
  ): Promise<Uint8Array> {
    const ordered = [...manifest.chunks].sort((a, b) => a.index - b.index)
    const parts: Uint8Array[] = []

    for (const chunk of ordered) {
      const encrypted = await this.bytes('GET', `/sync/attachments/chunks/${chunk.encryptedHash}`)
      const nonce = encrypted.subarray(0, NONCE_LEN)
      const ciphertext = encrypted.subarray(NONCE_LEN)
      const plaintext = await this.deps.crypto.decrypt(ciphertext, nonce, fileKey)
      if (sha256Hex(plaintext) !== chunk.hash) {
        throw new Error(`Chunk integrity failure at index ${chunk.index}`)
      }
      parts.push(plaintext)
    }

    const total = parts.reduce((sum, part) => sum + part.length, 0)
    const out = new Uint8Array(total)
    let offset = 0
    for (const part of parts) {
      out.set(part, offset)
      offset += part.length
    }
    return out
  }

  /**
   * Upload a local file and return its attachment id (T073).
   *
   * Same chunk framing as desktop — `nonce || ciphertext`, addressed by the
   * ciphertext's sha256 — so a file uploaded from the phone downloads on the
   * desktop with no special case.
   */
  async upload(
    attachmentId: string,
    filename: string,
    mimeType: string,
    bytes: Uint8Array
  ): Promise<AttachmentManifest> {
    const vaultKey = this.deps.vaultKey()
    const signing = this.deps.signing()
    if (!vaultKey || !signing) throw new Error('Vault is locked; cannot upload')

    const fileKey = this.deps.crypto.generateFileKey()
    try {
      return await this.uploadWithKey(
        attachmentId,
        filename,
        mimeType,
        bytes,
        vaultKey,
        signing,
        fileKey
      )
    } finally {
      fileKey.fill(0)
    }
  }

  private async uploadWithKey(
    attachmentId: string,
    filename: string,
    mimeType: string,
    bytes: Uint8Array,
    vaultKey: Uint8Array,
    signing: { secretKey: Uint8Array; deviceId: string },
    fileKey: Uint8Array
  ): Promise<AttachmentManifest> {
    const chunkRefs: AttachmentChunkRef[] = []
    const encryptedChunks: Uint8Array[] = []

    for (let offset = 0, index = 0; offset < bytes.length; offset += CHUNK_SIZE, index++) {
      const chunk = bytes.subarray(offset, Math.min(offset + CHUNK_SIZE, bytes.length))
      const { ciphertext, nonce } = this.deps.crypto.encrypt(chunk, fileKey)
      const framed = new Uint8Array(nonce.length + ciphertext.length)
      framed.set(nonce, 0)
      framed.set(ciphertext, nonce.length)
      encryptedChunks.push(framed)
      chunkRefs.push({
        index,
        hash: sha256Hex(chunk),
        encryptedHash: sha256Hex(framed),
        size: chunk.length
      })
    }

    const manifest: AttachmentManifest = {
      id: attachmentId,
      filename,
      mimeType,
      size: bytes.length,
      checksum: sha256Hex(bytes),
      chunks: chunkRefs,
      chunkSize: CHUNK_SIZE,
      createdAt: Date.now()
    }

    const session = await this.json<{ sessionId: string }>(
      'POST',
      '/sync/attachments/upload/initiate',
      {
        attachmentId,
        filename,
        totalSize: bytes.length,
        chunkCount: encryptedChunks.length,
        // Declared explicitly: the server reserves quota against the
        // CIPHERTEXT, and can otherwise only guess today's chunk framing.
        encryptedSize: encryptedChunks.reduce((sum, chunk) => sum + chunk.length, 0),
        chunkHashes: chunkRefs.map((ref) => ref.encryptedHash)
      }
    )

    for (let i = 0; i < encryptedChunks.length; i++) {
      await this.bytes(
        'PUT',
        `/sync/attachments/upload/${session.sessionId}/chunk/${i}`,
        encryptedChunks[i]
      )
    }
    await this.json('POST', `/sync/attachments/upload/${session.sessionId}/complete`, {})

    const encryptedManifest = encryptAttachmentManifest(
      this.deps.crypto,
      manifest,
      fileKey,
      vaultKey,
      signing
    )
    await this.bytes(
      'PUT',
      `/sync/attachments/${attachmentId}/manifest`,
      new TextEncoder().encode(JSON.stringify(encryptedManifest))
    )

    // Keep the bytes locally too: the note that just embedded this file must
    // render it immediately, offline, without a round trip through R2.
    const { path } = await this.store.writeBytes(this.deps.vaultId, attachmentId, bytes)
    await this.deps.db.runAsync(
      `INSERT INTO attachments (item_id, local_path, downloaded_at, remote_size, filename, mime_type, wifi_only, pinned)
       VALUES (?, ?, ?, ?, ?, ?, 0, 1)
       ON CONFLICT(item_id) DO UPDATE SET
         local_path = excluded.local_path,
         downloaded_at = excluded.downloaded_at,
         remote_size = excluded.remote_size,
         filename = excluded.filename,
         mime_type = excluded.mime_type,
         -- The policy columns too: a row can already exist (setWifiOnly, or a
         -- manifest peek), and leaving it lazy/unpinned for a file this device
         -- just uploaded means re-downloading bytes it is already holding.
         wifi_only = 0,
         pinned = 1`,
      [attachmentId, path, Date.now(), bytes.length, filename, mimeType]
    )

    return manifest
  }

  async readLocal(attachmentId: string): Promise<Uint8Array | null> {
    return this.store.readBytes(this.deps.vaultId, attachmentId)
  }

  // --- transport -----------------------------------------------------------

  private headers(contentType?: string): Record<string, string> {
    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.deps.accessToken()}`,
      'X-Memry-Vault-Id': this.deps.vaultId,
      [CLIENT_HEADER]: this.deps.clientHeaderValue
    }
    if (contentType) headers['Content-Type'] = contentType
    return headers
  }

  private async bytes(
    method: 'GET' | 'POST' | 'PUT',
    path: string,
    body?: Uint8Array
  ): Promise<Uint8Array> {
    const response = await this.deps.http.request({
      method,
      path,
      headers: this.headers(body ? 'application/octet-stream' : undefined),
      body
    })
    if (response.status < 200 || response.status >= 300) {
      throw new Error(`${method} ${path} failed with ${response.status}`)
    }
    return response.body
  }

  private async json<T>(method: 'GET' | 'POST' | 'PUT', path: string, body?: unknown): Promise<T> {
    const response = await this.deps.http.request({
      method,
      path,
      headers: this.headers(body === undefined ? undefined : 'application/json'),
      body: body === undefined ? undefined : new TextEncoder().encode(JSON.stringify(body))
    })
    if (response.status < 200 || response.status >= 300) {
      throw new Error(`${method} ${path} failed with ${response.status}`)
    }
    return JSON.parse(new TextDecoder().decode(response.body)) as T
  }
}
