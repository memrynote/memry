import { createReadStream } from 'node:fs'
import { stat, writeFile, rename } from 'node:fs/promises'
import { randomBytes } from 'node:crypto'
import path from 'node:path'
import sodium from 'libsodium-wrappers-sumo'
import { net } from 'electron'

import { createLogger } from '../lib/logger'
import { secureDeleteFile } from '../lib/secure-fs'
import { ensureDirectory } from '../vault/file-ops'
import { encrypt, decrypt, wrapFileKey, unwrapFileKey } from '../crypto/encryption'
import { generateFileKey } from '../crypto/keys'
import { secureCleanup } from '../crypto/index'
import { signPayload, verifySignature } from '../crypto/signatures'
import { CBOR_FIELD_ORDER } from '@memry/contracts/cbor-ordering'
import {
  NetworkError,
  SyncServerError,
  RateLimitError,
  parseRetryAfterHeader,
  type FetchFn
} from './http-client'
import { withRetry } from './retry'

import type { UploadInitResponse, UploadStatusResponse } from '@memry/contracts/blob-api'

const log = createLogger('Attachments')

const CHUNK_SIZE = 8 * 1024 * 1024
const MAX_ATTACHMENT_SIZE = 500 * 1024 * 1024
const MAX_CONCURRENT_CHUNKS = 4

// ============================================================================
// Types
// ============================================================================

export interface ChunkRef {
  index: number
  hash: string
  encryptedHash: string
  size: number
}

export interface AttachmentManifest {
  id: string
  filename: string
  mimeType: string
  size: number
  checksum: string
  chunks: ChunkRef[]
  chunkSize: number
  createdAt: number
}

export interface EncryptedAttachmentManifest {
  encryptedManifest: string
  manifestNonce: string
  encryptedFileKey: string
  keyNonce: string
  manifestSignature: string
  signerDeviceId: string
}

export interface UploadResult {
  attachmentId: string
  sessionId: string
  manifest: AttachmentManifest
}

export interface DownloadResult {
  filePath: string
  manifest: AttachmentManifest
}

export interface TransferProgress {
  attachmentId: string
  phase: 'hashing' | 'encrypting' | 'uploading' | 'downloading' | 'decrypting' | 'waiting_network'
  chunksCompleted: number
  totalChunks: number
  bytesTransferred: number
  totalBytes: number
}

export type ProgressCallback = (progress: TransferProgress) => void

interface UploadState {
  sessionId: string
  attachmentId: string
  completedChunks: Set<number>
  totalChunks: number
  totalBytes: number
}

export interface AttachmentSyncDeps {
  getAccessToken: () => Promise<string | null>
  getVaultKey: () => Promise<Uint8Array | null>
  getSigningKeys: () => Promise<{
    secretKey: Uint8Array
    publicKey: Uint8Array
    deviceId: string
  } | null>
  getDevicePublicKey: (deviceId: string) => Promise<Uint8Array | null>
  getSyncServerUrl: () => string
  fetchFn?: FetchFn
}

// ============================================================================
// Helpers — File Chunking (T148)
// ============================================================================

async function readFileChunks(filePath: string): Promise<Buffer[]> {
  const chunks: Buffer[] = []
  return new Promise((resolve, reject) => {
    const stream = createReadStream(filePath, { highWaterMark: CHUNK_SIZE })
    let currentChunk = Buffer.alloc(0)

    stream.on('data', (data: Buffer) => {
      currentChunk = Buffer.concat([currentChunk, data])
      while (currentChunk.length >= CHUNK_SIZE) {
        chunks.push(currentChunk.subarray(0, CHUNK_SIZE))
        currentChunk = currentChunk.subarray(CHUNK_SIZE)
      }
    })

    stream.on('end', () => {
      if (currentChunk.length > 0) {
        chunks.push(currentChunk)
      }
      resolve(chunks)
    })

    stream.on('error', reject)
  })
}

// ============================================================================
// Helpers — Hashing (T149)
// ============================================================================

function sha256Hex(data: Uint8Array): string {
  const hash = sodium.crypto_hash_sha256(data)
  return sodium.to_hex(hash)
}

// ============================================================================
// Helpers — Binary HTTP
// ============================================================================

async function binaryFetch(
  method: 'GET' | 'PUT' | 'HEAD' | 'POST',
  url: string,
  token: string,
  body?: Uint8Array | string,
  fetchFn?: FetchFn
): Promise<Response> {
  const fetchImpl = fetchFn ?? net.fetch

  const headers: Record<string, string> = {}
  if (token) {
    headers['Authorization'] = `Bearer ${token}`
  }
  if (body instanceof Uint8Array) {
    headers['Content-Type'] = 'application/octet-stream'
  } else if (typeof body === 'string') {
    headers['Content-Type'] = 'application/json'
  }

  const fetchBody = body instanceof Uint8Array ? Buffer.from(body) : (body ?? undefined)

  let response: Response
  try {
    response = await fetchImpl(url, {
      method,
      headers,
      body: fetchBody
    })
  } catch (err) {
    log.warn('fetch failed', { method, url, err })
    throw new NetworkError(
      'Unable to connect to sync server. Please check your internet connection.'
    )
  }

  if (response.status === 429) {
    const retryAfter = parseRetryAfterHeader(response.headers.get('Retry-After'))
    throw new RateLimitError(retryAfter)
  }

  return response
}

// ============================================================================
// Helpers — Parallel execution with concurrency limit
// ============================================================================

async function parallelMap<T, R>(
  items: T[],
  concurrency: number,
  fn: (item: T) => Promise<R>
): Promise<R[]> {
  const results: R[] = new Array(items.length)
  let nextIndex = 0

  async function worker(): Promise<void> {
    while (nextIndex < items.length) {
      const idx = nextIndex++
      results[idx] = await fn(items[idx])
    }
  }

  const workers = Array.from({ length: Math.min(concurrency, items.length) }, () => worker())
  await Promise.all(workers)
  return results
}

// ============================================================================
// AttachmentSyncService
// ============================================================================

export class AttachmentSyncService {
  private deps: AttachmentSyncDeps
  private activeUploads = new Map<string, UploadState>()
  private activeDownloads = new Map<string, TransferProgress>()
  private onProgress: ProgressCallback | null = null

  constructor(deps: AttachmentSyncDeps) {
    this.deps = deps
  }

  setProgressCallback(cb: ProgressCallback | null): void {
    this.onProgress = cb
  }

  // ==========================================================================
  // Upload (T151, T152)
  // ==========================================================================

  async uploadAttachment(
    noteId: string,
    filePath: string,
    onProgress?: ProgressCallback,
    options?: { signal?: AbortSignal; isOnline?: () => boolean }
  ): Promise<UploadResult> {
    const [token, vaultKey, signingKeys] = await this.requireAuth()
    const fileKey = generateFileKey()
    const emit = (p: TransferProgress): void => (onProgress ?? this.onProgress)?.(p)

    try {
      const fileStat = await stat(filePath)
      if (fileStat.size > MAX_ATTACHMENT_SIZE) {
        throw new Error(
          `File too large: ${(fileStat.size / (1024 * 1024)).toFixed(1)}MB exceeds ${MAX_ATTACHMENT_SIZE / (1024 * 1024)}MB limit`
        )
      }
      if (fileStat.size === 0) {
        throw new Error('Cannot upload empty file')
      }

      const attachmentId = sodium.to_hex(sodium.randombytes_buf(16))
      const filename = path.basename(filePath)
      log.info('starting upload', { attachmentId, noteId, filename, size: fileStat.size })

      const chunks = await readFileChunks(filePath)
      const totalChunks = chunks.length

      const wholeFileHashState = sodium.crypto_hash_sha256_init()
      const chunkRefs: ChunkRef[] = []
      const encryptedChunks: { data: Uint8Array; ref: ChunkRef }[] = []

      for (let i = 0; i < totalChunks; i++) {
        emit({
          attachmentId,
          phase: 'hashing',
          chunksCompleted: i,
          totalChunks,
          bytesTransferred: 0,
          totalBytes: fileStat.size
        })

        const chunk = chunks[i]
        sodium.crypto_hash_sha256_update(wholeFileHashState, chunk)
        const plaintextHash = sha256Hex(chunk)

        const { ciphertext, nonce } = encrypt(chunk, fileKey)
        const encryptedWithNonce = new Uint8Array(nonce.length + ciphertext.length)
        encryptedWithNonce.set(nonce, 0)
        encryptedWithNonce.set(ciphertext, nonce.length)

        const encryptedHash = sha256Hex(encryptedWithNonce)

        const ref: ChunkRef = {
          index: i,
          hash: plaintextHash,
          encryptedHash,
          size: chunk.length
        }
        chunkRefs.push(ref)
        encryptedChunks.push({ data: encryptedWithNonce, ref })

        emit({
          attachmentId,
          phase: 'encrypting',
          chunksCompleted: i + 1,
          totalChunks,
          bytesTransferred: 0,
          totalBytes: fileStat.size
        })
      }

      const wholeFileHash = sodium.to_hex(sodium.crypto_hash_sha256_final(wholeFileHashState))

      const manifest: AttachmentManifest = {
        id: attachmentId,
        filename,
        mimeType: guessMimeType(filename),
        size: fileStat.size,
        checksum: wholeFileHash,
        chunks: chunkRefs,
        chunkSize: CHUNK_SIZE,
        createdAt: Date.now()
      }

      const netOpts: { signal?: AbortSignal; isOnline?: () => boolean } = {}
      if (options?.signal) netOpts.signal = options.signal
      if (options?.isOnline) netOpts.isOnline = options.isOnline

      const sessionId = await this.initiateUploadSession(
        token,
        attachmentId,
        filename,
        fileStat.size,
        totalChunks,
        netOpts
      )

      const uploadState: UploadState = {
        sessionId,
        attachmentId,
        completedChunks: new Set(),
        totalChunks,
        totalBytes: fileStat.size
      }
      this.activeUploads.set(sessionId, uploadState)

      const existingChunks = await this.checkResumableSession(token, sessionId, netOpts)
      if (existingChunks) {
        for (const idx of existingChunks) {
          uploadState.completedChunks.add(idx)
        }
        log.info('resuming upload', {
          sessionId,
          existingChunks: existingChunks.length,
          totalChunks
        })
      }

      const chunksToUpload = encryptedChunks.filter(
        (c) => !uploadState.completedChunks.has(c.ref.index)
      )

      let bytesUploaded =
        uploadState.completedChunks.size > 0
          ? Array.from(uploadState.completedChunks).reduce(
              (sum, idx) => sum + (chunkRefs[idx]?.size ?? 0),
              0
            )
          : 0

      await parallelMap(chunksToUpload, MAX_CONCURRENT_CHUNKS, async (chunk) => {
        const onWaitingNetwork = (): void => {
          emit({
            attachmentId,
            phase: 'waiting_network',
            chunksCompleted: uploadState.completedChunks.size,
            totalChunks,
            bytesTransferred: bytesUploaded,
            totalBytes: fileStat.size
          })
        }

        const dedupExists = await this.checkChunkDedup(token, chunk.ref.encryptedHash, netOpts)
        if (dedupExists) {
          log.debug('chunk deduped', { index: chunk.ref.index, hash: chunk.ref.encryptedHash })
        } else {
          await this.uploadChunk(token, sessionId, chunk.ref.index, chunk.data, {
            ...netOpts,
            onWaitingNetwork
          })
        }

        uploadState.completedChunks.add(chunk.ref.index)
        bytesUploaded += chunk.ref.size

        emit({
          attachmentId,
          phase: 'uploading',
          chunksCompleted: uploadState.completedChunks.size,
          totalChunks,
          bytesTransferred: bytesUploaded,
          totalBytes: fileStat.size
        })
      })

      const encryptedManifest = this.encryptManifest(manifest, fileKey, vaultKey, signingKeys)
      await this.completeUploadSession(token, sessionId, encryptedManifest, netOpts)

      this.activeUploads.delete(sessionId)
      log.info('upload complete', { attachmentId, sessionId })

      return { attachmentId, sessionId, manifest }
    } finally {
      secureCleanup(fileKey)
      secureCleanup(signingKeys.secretKey)
    }
  }

  // ==========================================================================
  // Download (T151 download side)
  // ==========================================================================

  async downloadAttachment(attachmentId: string, targetPath: string): Promise<DownloadResult> {
    const [token, vaultKey] = await this.requireAuth()

    log.info('starting download', { attachmentId })

    const encryptedManifest = await this.fetchManifest(token, attachmentId)

    const signerPublicKey = await this.deps.getDevicePublicKey(encryptedManifest.signerDeviceId)
    if (!signerPublicKey) {
      throw new Error(
        `Unknown signer device: ${encryptedManifest.signerDeviceId}. Cannot verify manifest.`
      )
    }

    const { manifest, fileKey } = this.decryptManifest(encryptedManifest, vaultKey, signerPublicKey)

    try {
      const totalChunks = manifest.chunks.length
      const destPath = targetPath

      const downloadProgress: TransferProgress = {
        attachmentId,
        phase: 'downloading',
        chunksCompleted: 0,
        totalChunks,
        bytesTransferred: 0,
        totalBytes: manifest.size
      }
      this.activeDownloads.set(attachmentId, downloadProgress)

      const decryptedChunks: Buffer[] = new Array(totalChunks)
      let bytesDownloaded = 0

      await parallelMap(manifest.chunks, MAX_CONCURRENT_CHUNKS, async (chunkRef) => {
        const encryptedData = await this.downloadChunk(token, chunkRef.encryptedHash)

        const nonce = encryptedData.subarray(0, 24)
        const ciphertext = encryptedData.subarray(24)
        const plaintext = decrypt(ciphertext, nonce, fileKey)

        const actualHash = sha256Hex(plaintext)
        if (actualHash !== chunkRef.hash) {
          throw new Error(
            `Chunk integrity failure at index ${chunkRef.index}: expected ${chunkRef.hash}, got ${actualHash}`
          )
        }

        decryptedChunks[chunkRef.index] = Buffer.from(plaintext)
        bytesDownloaded += chunkRef.size

        downloadProgress.chunksCompleted++
        downloadProgress.bytesTransferred = bytesDownloaded
        downloadProgress.phase = 'decrypting'
        this.emitProgress({ ...downloadProgress })
      })

      const reassembled = Buffer.concat(decryptedChunks)

      const wholeHash = sha256Hex(reassembled)
      if (wholeHash !== manifest.checksum) {
        throw new Error(`File integrity failure: expected ${manifest.checksum}, got ${wholeHash}`)
      }

      await this.atomicWriteBinary(destPath, reassembled)

      this.activeDownloads.delete(attachmentId)
      log.info('download complete', { attachmentId, path: destPath })

      return { filePath: destPath, manifest }
    } finally {
      secureCleanup(fileKey)
    }
  }

  // ==========================================================================
  // Progress queries
  // ==========================================================================

  getUploadProgress(sessionId: string): TransferProgress | null {
    const state = this.activeUploads.get(sessionId)
    if (!state) return null
    return {
      attachmentId: state.attachmentId,
      phase: 'uploading',
      chunksCompleted: state.completedChunks.size,
      totalChunks: state.totalChunks,
      bytesTransferred: 0,
      totalBytes: state.totalBytes
    }
  }

  getDownloadProgress(attachmentId: string): TransferProgress | null {
    return this.activeDownloads.get(attachmentId) ?? null
  }

  async cancelUpload(sessionId: string): Promise<void> {
    this.activeUploads.delete(sessionId)
    log.info('upload cancelled', { sessionId })
  }

  // ==========================================================================
  // Server communication
  // ==========================================================================

  private async initiateUploadSession(
    token: string,
    attachmentId: string,
    filename: string,
    totalSize: number,
    chunkCount: number,
    options?: { signal?: AbortSignal; isOnline?: () => boolean }
  ): Promise<string> {
    const url = `${this.deps.getSyncServerUrl()}/sync/attachments/upload/initiate`
    const body = JSON.stringify({ attachmentId, filename, totalSize, chunkCount })

    const retryOpts: Partial<import('./retry').RetryOptions> = { maxRetries: 3, baseDelayMs: 2000 }
    if (options?.signal) retryOpts.signal = options.signal
    if (options?.isOnline) retryOpts.isOnline = options.isOnline

    const { value: resp } = await withRetry(
      () => binaryFetch('POST', url, token, body, this.deps.fetchFn),
      retryOpts
    )
    if (!resp.ok) {
      const errBody = await resp.text()
      throw new SyncServerError(`Failed to initiate upload: ${errBody}`, resp.status)
    }

    const data = (await resp.json()) as UploadInitResponse
    return data.sessionId
  }

  private async checkResumableSession(
    token: string,
    sessionId: string,
    options?: { signal?: AbortSignal; isOnline?: () => boolean }
  ): Promise<number[] | null> {
    const url = `${this.deps.getSyncServerUrl()}/sync/attachments/upload/${sessionId}`

    try {
      const retryOpts: Partial<import('./retry').RetryOptions> = {
        maxRetries: 2,
        baseDelayMs: 1000
      }
      if (options?.signal) retryOpts.signal = options.signal
      if (options?.isOnline) retryOpts.isOnline = options.isOnline

      const { value: resp } = await withRetry(
        () => binaryFetch('GET', url, token, undefined, this.deps.fetchFn),
        retryOpts
      )

      if (resp.status === 410) {
        log.info('session expired, starting fresh', { sessionId })
        return null
      }
      if (!resp.ok) return null

      const data = (await resp.json()) as UploadStatusResponse
      return data.uploadedChunks.length > 0 ? data.uploadedChunks : null
    } catch {
      log.warn('checkResumableSession failed, starting fresh', { sessionId })
      return null
    }
  }

  private async checkChunkDedup(
    token: string,
    encryptedHash: string,
    options?: { signal?: AbortSignal; isOnline?: () => boolean }
  ): Promise<boolean> {
    const url = `${this.deps.getSyncServerUrl()}/sync/attachments/chunks/${encryptedHash}`
    const retryOpts: Partial<import('./retry').RetryOptions> = { maxRetries: 3, baseDelayMs: 1000 }
    if (options?.signal) retryOpts.signal = options.signal
    if (options?.isOnline) retryOpts.isOnline = options.isOnline

    try {
      const { value: resp } = await withRetry(
        () => binaryFetch('HEAD', url, token, undefined, this.deps.fetchFn),
        retryOpts
      )
      return resp.status === 200
    } catch {
      log.warn('checkChunkDedup failed, assuming not deduped', { encryptedHash })
      return false
    }
  }

  private async uploadChunk(
    token: string,
    sessionId: string,
    chunkIndex: number,
    data: Uint8Array,
    options?: { signal?: AbortSignal; isOnline?: () => boolean; onWaitingNetwork?: () => void }
  ): Promise<void> {
    const url = `${this.deps.getSyncServerUrl()}/sync/attachments/upload/${sessionId}/chunk/${chunkIndex}`
    const retryOpts: Partial<import('./retry').RetryOptions> = {
      maxRetries: 5,
      baseDelayMs: 2000,
      onRetry: (_attempt, error) => {
        if (error instanceof NetworkError) options?.onWaitingNetwork?.()
      }
    }
    if (options?.signal) retryOpts.signal = options.signal
    if (options?.isOnline) retryOpts.isOnline = options.isOnline

    const { value: resp } = await withRetry(
      () => binaryFetch('PUT', url, token, data, this.deps.fetchFn),
      retryOpts
    )

    if (!resp.ok) {
      const errBody = await resp.text()
      throw new SyncServerError(`Failed to upload chunk ${chunkIndex}: ${errBody}`, resp.status)
    }
  }

  private async completeUploadSession(
    token: string,
    sessionId: string,
    encryptedManifest: EncryptedAttachmentManifest,
    options?: { signal?: AbortSignal; isOnline?: () => boolean }
  ): Promise<void> {
    const url = `${this.deps.getSyncServerUrl()}/sync/attachments/upload/${sessionId}/complete`
    const body = JSON.stringify(encryptedManifest)

    const retryOpts: Partial<import('./retry').RetryOptions> = { maxRetries: 3, baseDelayMs: 2000 }
    if (options?.signal) retryOpts.signal = options.signal
    if (options?.isOnline) retryOpts.isOnline = options.isOnline

    const { value: resp } = await withRetry(
      () => binaryFetch('POST', url, token, body, this.deps.fetchFn),
      retryOpts
    )

    if (!resp.ok) {
      const errBody = await resp.text()
      throw new SyncServerError(`Failed to complete upload: ${errBody}`, resp.status)
    }
  }

  private async fetchManifest(
    token: string,
    attachmentId: string
  ): Promise<EncryptedAttachmentManifest> {
    const url = `${this.deps.getSyncServerUrl()}/sync/attachments/${attachmentId}/manifest`
    const resp = await binaryFetch('GET', url, token, undefined, this.deps.fetchFn)

    if (!resp.ok) {
      throw new SyncServerError(`Failed to fetch manifest for ${attachmentId}`, resp.status)
    }

    return (await resp.json()) as EncryptedAttachmentManifest
  }

  private async downloadChunk(token: string, encryptedHash: string): Promise<Uint8Array> {
    const url = `${this.deps.getSyncServerUrl()}/sync/attachments/chunks/${encryptedHash}`
    const resp = await binaryFetch('GET', url, token, undefined, this.deps.fetchFn)

    if (!resp.ok) {
      throw new SyncServerError(`Failed to download chunk ${encryptedHash}`, resp.status)
    }

    const arrayBuffer = await resp.arrayBuffer()
    return new Uint8Array(arrayBuffer)
  }

  // ==========================================================================
  // Crypto — Manifest encryption/decryption
  // ==========================================================================

  private encryptManifest(
    manifest: AttachmentManifest,
    fileKey: Uint8Array,
    vaultKey: Uint8Array,
    signingKeys: { secretKey: Uint8Array; publicKey: Uint8Array; deviceId: string }
  ): EncryptedAttachmentManifest {
    const toB64 = (bytes: Uint8Array): string =>
      sodium.to_base64(bytes, sodium.base64_variants.ORIGINAL)

    const manifestBytes = new TextEncoder().encode(JSON.stringify(manifest))
    const { ciphertext: encManifest, nonce: manifestNonce } = encrypt(manifestBytes, fileKey)
    const { wrappedKey, nonce: keyNonce } = wrapFileKey(fileKey, vaultKey)

    const signaturePayload: Record<string, unknown> = {
      encryptedManifest: toB64(encManifest),
      manifestNonce: toB64(manifestNonce),
      encryptedFileKey: toB64(wrappedKey),
      keyNonce: toB64(keyNonce)
    }

    const signature = signPayload(
      signaturePayload,
      CBOR_FIELD_ORDER.ATTACHMENT_MANIFEST,
      signingKeys.secretKey
    )

    return {
      encryptedManifest: toB64(encManifest),
      manifestNonce: toB64(manifestNonce),
      encryptedFileKey: toB64(wrappedKey),
      keyNonce: toB64(keyNonce),
      manifestSignature: toB64(signature),
      signerDeviceId: signingKeys.deviceId
    }
  }

  private decryptManifest(
    encrypted: EncryptedAttachmentManifest,
    vaultKey: Uint8Array,
    signerPublicKey: Uint8Array
  ): { manifest: AttachmentManifest; fileKey: Uint8Array } {
    const fromB64 = (s: string): Uint8Array =>
      sodium.from_base64(s, sodium.base64_variants.ORIGINAL)

    const signaturePayload: Record<string, unknown> = {
      encryptedManifest: encrypted.encryptedManifest,
      manifestNonce: encrypted.manifestNonce,
      encryptedFileKey: encrypted.encryptedFileKey,
      keyNonce: encrypted.keyNonce
    }

    const verified = verifySignature(
      signaturePayload,
      CBOR_FIELD_ORDER.ATTACHMENT_MANIFEST,
      fromB64(encrypted.manifestSignature),
      signerPublicKey
    )

    if (!verified) {
      throw new Error(
        `Manifest signature verification failed for device ${encrypted.signerDeviceId}`
      )
    }

    const wrappedKey = fromB64(encrypted.encryptedFileKey)
    const keyNonce = fromB64(encrypted.keyNonce)
    const fileKey = unwrapFileKey(wrappedKey, keyNonce, vaultKey)

    const encManifest = fromB64(encrypted.encryptedManifest)
    const manifestNonce = fromB64(encrypted.manifestNonce)
    const manifestBytes = decrypt(encManifest, manifestNonce, fileKey)

    const manifest = JSON.parse(new TextDecoder().decode(manifestBytes)) as AttachmentManifest
    return { manifest, fileKey }
  }

  // ==========================================================================
  // Internal utilities
  // ==========================================================================

  private async requireAuth(): Promise<
    [string, Uint8Array, { secretKey: Uint8Array; publicKey: Uint8Array; deviceId: string }]
  > {
    const [token, vaultKey, signingKeys] = await Promise.all([
      this.deps.getAccessToken(),
      this.deps.getVaultKey(),
      this.deps.getSigningKeys()
    ])

    if (!token) throw new Error('Not authenticated — no access token')
    if (!vaultKey) throw new Error('Vault is locked — no vault key')
    if (!signingKeys) throw new Error('Device keys not available')

    return [token, vaultKey, signingKeys]
  }

  private emitProgress(progress: TransferProgress): void {
    this.onProgress?.(progress)
  }

  private async atomicWriteBinary(filePath: string, data: Buffer): Promise<void> {
    const dir = path.dirname(filePath)
    const tempPath = path.join(dir, `.${randomBytes(6).toString('hex')}.tmp`)

    await ensureDirectory(dir)
    await writeFile(tempPath, data)

    try {
      await rename(tempPath, filePath)
    } catch {
      try {
        await secureDeleteFile(tempPath)
      } catch {
        // ignore cleanup errors
      }
      throw new Error(`Failed to write attachment: ${filePath}`)
    }
  }
}

// ============================================================================
// Mime type heuristic
// ============================================================================

function guessMimeType(filename: string): string {
  const ext = path.extname(filename).toLowerCase()
  const mimeMap: Record<string, string> = {
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.gif': 'image/gif',
    '.webp': 'image/webp',
    '.svg': 'image/svg+xml',
    '.pdf': 'application/pdf',
    '.mp4': 'video/mp4',
    '.webm': 'video/webm',
    '.mp3': 'audio/mpeg',
    '.wav': 'audio/wav',
    '.zip': 'application/zip',
    '.txt': 'text/plain',
    '.md': 'text/markdown',
    '.json': 'application/json',
    '.csv': 'text/csv'
  }
  return mimeMap[ext] ?? 'application/octet-stream'
}
