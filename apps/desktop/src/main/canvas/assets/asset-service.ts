/**
 * Canvas asset service — the M5 orchestrator that externalizes, dedups,
 * uploads, restores, and garbage-collects canvas image assets.
 *
 * Every side-effecting dependency (attachment upload/download, server
 * dereference, the writeback-ignore guard, telemetry) is INJECTED via
 * {@link AssetServiceContext} rather than imported, so this module stays
 * free of electron / sync / keychain wiring and is unit-testable in node.
 * The real context is assembled in `asset-service-context.ts`, which is the
 * only place that touches the attachment singletons and the sync runtime.
 *
 * Disk layout: assets live at a vault-level, content-addressed store
 * `{vaultPath}/attachments/canvas-assets/<contentHash>.<ext>` so the same
 * bytes are shared across canvases and the `memry-file://` protocol allowlist
 * + the download targetPath guard both already permit the path.
 */

import { rm } from 'node:fs/promises'
import { join } from 'node:path'

import type { DataDb } from '../../database'
import type { CanvasUploadAssetResponse, MemryAssetDescriptor } from '@memry/contracts/canvas-api'
import type { TelemetryEventName } from '@memry/contracts/telemetry-api'
import { buildErrorDetail, toErrorCode } from '@memry/contracts/telemetry-api'
import type { CanvasAssetRow } from '@memry/db-schema'

import { createLogger } from '../../lib/logger'
import { toMemryFileUrl } from '../../lib/paths'
import { atomicWriteBinary, fileExists } from '../../vault/file-ops'
import { getMainRedactOptions } from '../../telemetry/redact-options'
import type { TrackMainEventOptions } from '../../telemetry/track'

import { assetFilename, hashAssetContent } from './content-hash'
import { contentHashFromRef, extractSceneFileRefs, writeMemryAssets } from './memry-assets'
import {
  deleteCanvasAssetRows,
  findAssetByContentHash,
  hashesReferencedByOtherCanvases,
  listAssetsByCanvas,
  recordAsset
} from './asset-store'
import { planDereference } from './dedup-plan'

const log = createLogger('CanvasAssetService')

const CANVAS_ASSETS_DIR = 'canvas-assets'

/** Minimal shape of an attachment upload result — just what the GC index needs. */
export interface AssetUploadResult {
  attachmentId: string
  manifest: { chunks: { encryptedHash: string }[] }
}

/**
 * Injected dependencies for the asset service. The canvas-handlers layer
 * builds the real context (wiring the reused AttachmentSyncService / upload
 * queue singletons); tests inject fakes.
 */
export interface AssetServiceContext {
  db: DataDb
  vaultId: string
  vaultPath: string
  /** Upload a local file through the shared attachment pipeline; returns the manifest. */
  uploadAttachment: (canvasId: string, filePath: string) => Promise<AssetUploadResult>
  /** Download an attachment to targetPath through the shared attachment pipeline. */
  downloadAttachment: (attachmentId: string, targetPath: string) => Promise<void>
  /** Best-effort server ref_count decrement for GC'd chunks. Never throws. */
  /** Decrement server ref_count for these chunk hashes. Never throws; `ok` is false on a
   *  404 (endpoint not yet deployed) / missing token / offline, so the caller can keep the
   *  rows that hold these hashes and retry on a later reconcile instead of leaking ref_count. */
  dereference: (chunkHashes: string[]) => Promise<{ ok: boolean }>
  /** Suppress the vault watcher's re-upload loop before writing/downloading a file. */
  markWritebackIgnored: (absolutePath: string) => void
  trackEvent: (name: TelemetryEventName, options: TrackMainEventOptions) => void
}

/** Absolute path of a content-addressed asset in the vault-level store. */
export function canvasAssetDiskPath(vaultPath: string, filename: string): string {
  return join(vaultPath, 'attachments', CANVAS_ASSETS_DIR, filename)
}

function rowToDescriptor(row: CanvasAssetRow): MemryAssetDescriptor {
  return {
    fileId: row.fileId,
    attachmentId: row.attachmentId,
    contentHash: row.contentHash,
    chunkHashes: row.chunkHashes,
    mimeType: row.mimeType,
    sizeBytes: row.sizeBytes,
    filename: row.filename
  }
}

/** Content hashes still present as externalized `memry-file://` refs in a scene. */
function sceneContentHashes(sceneJson: string): Set<string> {
  return new Set(
    extractSceneFileRefs(sceneJson)
      .map((r) => contentHashFromRef(r.ref))
      .filter((h): h is string => !!h)
  )
}

/**
 * Externalize one Excalidraw image: content-address it, dedup against the
 * vault store, upload the bytes if new, and record the per-(canvas,image)
 * dedup/GC row. Idempotent on disk.
 */
export async function uploadCanvasAsset(
  ctx: AssetServiceContext,
  canvasId: string,
  fileId: string,
  mimeType: string,
  bytes: Uint8Array
): Promise<CanvasUploadAssetResponse> {
  const contentHash = hashAssetContent(bytes)
  const filename = assetFilename(contentHash, mimeType)
  const diskPath = canvasAssetDiskPath(ctx.vaultPath, filename)
  const ref = toMemryFileUrl(diskPath)

  const existing = findAssetByContentHash(ctx.db, ctx.vaultId, contentHash)
  if (existing) {
    // Dedup hit: the bytes already exist somewhere in the vault. Reuse the
    // attachment id / chunk hashes; only re-materialize the local file if this
    // device is missing it. No upload. Resolve path/ref from the RECORDED
    // filename (existing.filename), not the locally-computed one — they can
    // diverge if the same bytes were ever recorded under a different mimeType
    // (different extension), and writing/returning the wrong path would point
    // a later restore at a file that doesn't exist.
    const existingDiskPath = canvasAssetDiskPath(ctx.vaultPath, existing.filename)
    if (!(await fileExists(existingDiskPath))) {
      ctx.markWritebackIgnored(existingDiskPath)
      await atomicWriteBinary(existingDiskPath, bytes)
    }
    recordAsset(ctx.db, {
      vaultId: ctx.vaultId,
      canvasId,
      contentHash,
      attachmentId: existing.attachmentId,
      fileId,
      filename: existing.filename,
      mimeType: existing.mimeType,
      sizeBytes: existing.sizeBytes,
      chunkHashes: existing.chunkHashes,
      createdAt: Date.now()
    })
    const descriptor: MemryAssetDescriptor = {
      fileId,
      attachmentId: existing.attachmentId,
      contentHash,
      chunkHashes: existing.chunkHashes,
      mimeType: existing.mimeType,
      sizeBytes: existing.sizeBytes,
      filename: existing.filename
    }
    ctx.trackEvent('canvas_asset_dedup_hit', {
      surface: 'sync',
      action: 'dedup',
      objectType: 'canvas',
      result: 'success',
      metrics: { byteCount: existing.sizeBytes }
    })
    return { ref: toMemryFileUrl(existingDiskPath), descriptor, deduped: true }
  }

  // New asset: write it to the content-addressed store, then upload the bytes
  // through the shared attachment pipeline to capture its chunk manifest.
  // The path is content-addressed and the write is atomic, so a file already
  // sitting there is these exact bytes from an earlier attempt whose upload
  // failed — rewriting it would be pure disk churn on every retry (#1581).
  if (!(await fileExists(diskPath))) {
    ctx.markWritebackIgnored(diskPath)
    await atomicWriteBinary(diskPath, bytes)
  }

  const { attachmentId, manifest } = await ctx.uploadAttachment(canvasId, diskPath)
  const chunkHashes = manifest.chunks.map((c) => c.encryptedHash)
  const sizeBytes = bytes.length

  recordAsset(ctx.db, {
    vaultId: ctx.vaultId,
    canvasId,
    contentHash,
    attachmentId,
    fileId,
    filename,
    mimeType,
    sizeBytes,
    chunkHashes,
    createdAt: Date.now()
  })
  const descriptor: MemryAssetDescriptor = {
    fileId,
    attachmentId,
    contentHash,
    chunkHashes,
    mimeType,
    sizeBytes,
    filename
  }
  ctx.trackEvent('canvas_asset_uploaded', {
    surface: 'sync',
    action: 'upload',
    objectType: 'canvas',
    result: 'success',
    metrics: { byteCount: sizeBytes }
  })
  return { ref, descriptor, deduped: false }
}

/**
 * Device-B restore: download any asset in `descriptors` that is missing on
 * disk, and record its local dedup/GC row. One failed asset must not abort the
 * rest, so per-asset errors are swallowed (logged). Called by the canvas sync
 * apply path (Task 9) with the canvas the scene belongs to.
 */
export async function ensureAssetsPresent(
  ctx: AssetServiceContext,
  canvasId: string,
  descriptors: MemryAssetDescriptor[]
): Promise<void> {
  for (const descriptor of descriptors) {
    const diskPath = canvasAssetDiskPath(ctx.vaultPath, descriptor.filename)
    if (await fileExists(diskPath)) continue

    try {
      ctx.markWritebackIgnored(diskPath)
      await ctx.downloadAttachment(descriptor.attachmentId, diskPath)
      recordAsset(ctx.db, {
        vaultId: ctx.vaultId,
        canvasId,
        contentHash: descriptor.contentHash,
        attachmentId: descriptor.attachmentId,
        fileId: descriptor.fileId,
        filename: descriptor.filename,
        mimeType: descriptor.mimeType,
        sizeBytes: descriptor.sizeBytes,
        chunkHashes: descriptor.chunkHashes,
        createdAt: Date.now()
      })
    } catch (err) {
      log.warn('failed to restore canvas asset; leaving it for a later retry', {
        canvasId,
        fileId: descriptor.fileId,
        err
      })
      // The receiving user sees a broken image on the synced canvas — surface
      // the failure through the injected sink (telemetry stays injectable).
      ctx.trackEvent('app_error_seen', {
        surface: 'sync',
        action: 'canvas_asset_restore',
        objectType: 'exception',
        source: 'canvas_asset_service',
        result: 'failed',
        errorCode: toErrorCode(err),
        error: buildErrorDetail(err, undefined, getMainRedactOptions())
      })
    }
  }
}

/**
 * Garbage-collect assets a canvas no longer references. Runs on every save
 * (with the saved scene) and on delete (`sceneJson === ''`). Prunes the local
 * rows for removed assets, dereferences the server chunks of assets referenced
 * by NO other canvas, and safely unlinks the on-disk file when it is shared by
 * nobody.
 */
export async function reconcileCanvasAssets(
  ctx: AssetServiceContext,
  canvasId: string,
  sceneJson: string
): Promise<void> {
  const current = sceneContentHashes(sceneJson)
  const prev = listAssetsByCanvas(ctx.db, canvasId)
  const others = hashesReferencedByOtherCanvases(ctx.db, ctx.vaultId, canvasId)

  const plan = planDereference(prev, current, others)
  if (plan.removedContentHashes.length === 0) return

  // Shared removed content — still referenced by another canvas, so no server call is needed;
  // prune the local row immediately.
  const dereferenced = new Set(plan.dereferencedContentHashes)
  const sharedRemoved = plan.removedContentHashes.filter((hash) => !dereferenced.has(hash))
  if (sharedRemoved.length > 0) {
    deleteCanvasAssetRows(ctx.db, canvasId, sharedRemoved)
  }

  if (plan.dereferencedContentHashes.length === 0) return

  // Orphaned content — dereference on the server FIRST, and prune the rows (which hold the
  // chunkHashes needed to retry) only once the server confirms. A 404 (endpoint not yet
  // deployed) / transient outage keeps the rows so the next reconcile retries, instead of
  // silently leaking ref_count forever.
  const { ok } = await ctx.dereference(plan.dereferenceChunkHashes)
  if (!ok) {
    log.warn('canvas asset dereference failed; keeping rows for a later retry', {
      canvasId,
      contentHashes: plan.dereferencedContentHashes.length
    })
    return
  }

  deleteCanvasAssetRows(ctx.db, canvasId, plan.dereferencedContentHashes)
  ctx.trackEvent('canvas_asset_gc_reaped', {
    surface: 'sync',
    action: 'gc',
    objectType: 'canvas',
    result: 'success',
    metrics: { itemCount: plan.dereferencedContentHashes.length }
  })

  // Safe on-disk delete: only the reaped content (referenced by NEITHER the saved scene NOR
  // any other canvas — i.e. exactly the dereferenced set).
  for (const row of prev) {
    if (!dereferenced.has(row.contentHash)) continue

    const diskPath = canvasAssetDiskPath(ctx.vaultPath, row.filename)
    try {
      ctx.markWritebackIgnored(diskPath)
      await rm(diskPath, { force: true })
    } catch (err) {
      log.warn('failed to unlink orphaned canvas asset file', {
        canvasId,
        contentHash: row.contentHash,
        err
      })
    }
  }
}

/**
 * Resolve the `memry-file://` ref for one scene file id on a canvas, or null
 * when there is no recorded asset for it (pre-M5 / inline scenes).
 */
export function getCanvasAssetRef(
  ctx: AssetServiceContext,
  canvasId: string,
  fileId: string
): string | null {
  const row = listAssetsByCanvas(ctx.db, canvasId).find((r) => r.fileId === fileId)
  if (!row) return null
  return toMemryFileUrl(canvasAssetDiskPath(ctx.vaultPath, row.filename))
}

/** All asset descriptors recorded for a canvas. */
export function listCanvasAssetDescriptors(
  ctx: AssetServiceContext,
  canvasId: string
): MemryAssetDescriptor[] {
  return listAssetsByCanvas(ctx.db, canvasId).map(rowToDescriptor)
}

/**
 * Inject the `memryAssets` sidecar into a scene before it is persisted/synced,
 * so a receiving device can restore the externalized images. Descriptors are
 * the recorded rows still referenced by this scene. Returns the scene
 * unchanged when it is empty or unparseable (pre-M5 / brand-new canvases).
 */
export function injectSceneAssetSidecar(
  ctx: AssetServiceContext,
  canvasId: string,
  sceneJson: string
): string {
  if (!sceneJson) return sceneJson
  const current = sceneContentHashes(sceneJson)
  const descriptors = listAssetsByCanvas(ctx.db, canvasId)
    .filter((row) => current.has(row.contentHash))
    .map(rowToDescriptor)
  try {
    return writeMemryAssets(sceneJson, descriptors)
  } catch {
    // Unparseable scene — never corrupt it by dropping the payload.
    return sceneJson
  }
}
