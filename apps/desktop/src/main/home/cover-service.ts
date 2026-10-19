/**
 * Home board covers (#3384): the banner across the top of a board.
 *
 * A cover is a wash, or an image the board owns at
 * `.memry/home-covers/<boardId>/<file>`. Every image source the note cover
 * picker offers (upload, Unsplash, a link, an image already in the vault) is
 * copied there, so a board never depends on a note's attachment and deleting
 * the note cannot break it.
 *
 * The bytes sync as one encrypted attachment through the shared upload and
 * download queues, the way canvas assets do. The row's `cover.attachmentId`
 * records it, and it travels in the `home_page` payload. Both directions are
 * settled by {@link reconcileHomeCovers}, which is idempotent and runs when
 * sync starts, on reconnect, and when the renderer finds a cover's file
 * missing:
 * - a file with no attachment id is uploaded (a first upload that failed or
 *   ran offline);
 * - an attachment id with no file is downloaded to exactly `ref`.
 *
 * @module home/cover-service
 */

import { mkdir, readdir, readFile, rm } from 'node:fs/promises'
import path from 'node:path'
import type {
  HomePageCoverFailure,
  HomePageCoverSource,
  HomePageSetCoverFramingSchema
} from '@memry/contracts/home-page-api'
import { HomePagesChannels } from '@memry/contracts/ipc-channels'
import type { HomePageCoverSync } from '@memry/contracts/sync-payloads'
import type { HomePageRow } from '@memry/db-schema/schema/home-pages'
import {
  DEFAULT_COVER_FRAMING,
  clampCoverFocus,
  clampCoverHeight,
  clampCoverZoom,
  coverWashRef,
  isCoverWashId
} from '@memry/shared/cover-image'
import type { z } from 'zod'
import type { DataDb } from '../database/types'
import { getCanvasAssetIO } from '../ipc/sync-attachment-handlers'
import { createLogger } from '../lib/logger'
import { broadcastToAllWindows } from '../lib/window-broadcast'
import { fetchUnsplashPhoto, type UnsplashFetch } from '../unsplash/service'
import {
  generateUniqueFilename,
  getNoteAttachmentsDir,
  isAllowedFileType,
  validateFileSize
} from '../vault/attachments'
import { atomicWriteBinary, fileExists } from '../vault/file-ops'
import { getStatus as getVaultStatus } from '../vault/index'
import { fetchRemoteImage } from '../vault/remote-attachment'
import { enqueueHomePageUpdate } from './runtime-effects'
import { getHomePage, listHomePages, updateHomePage } from './store'

const log = createLogger('HomeCover')

/** Vault-relative, `/`-separated: the form a ref carries on every platform. */
const HOME_COVERS_DIR = '.memry/home-covers'

export interface HomeCoverDeps {
  db: DataDb
  vaultPath: string
  /** Serves both the link and the Unsplash sources. */
  fetch: UnsplashFetch
}

export type SetHomeCoverResult =
  { ok: true; row: HomePageRow } | { ok: false; reason: HomePageCoverFailure }

type FramingChanges = z.infer<typeof HomePageSetCoverFramingSchema>['changes']

/** The open vault's root; a cover always belongs to the open vault. */
export function requireVaultPath(): string {
  const vaultPath = getVaultStatus().path
  if (!vaultPath) throw new Error('No vault is open')
  return vaultPath
}

function isPlainSegment(value: string): boolean {
  return value.length > 0 && !/[/\\]/.test(value) && value !== '.' && value !== '..'
}

function coverDir(vaultPath: string, boardId: string): string {
  return path.join(vaultPath, ...HOME_COVERS_DIR.split('/'), boardId)
}

/**
 * The absolute file a cover ref names, or null when the ref is a wash, a URL,
 * or not inside this board's own folder. The last case refuses a synced ref
 * that would point a download anywhere else in the vault.
 */
export function homeCoverFilePath(vaultPath: string, boardId: string, ref: string): string | null {
  const prefix = `${HOME_COVERS_DIR}/${boardId}/`
  if (!ref.startsWith(prefix)) return null
  const filename = ref.slice(prefix.length)
  return isPlainSegment(filename) ? path.join(coverDir(vaultPath, boardId), filename) : null
}

/** Commit a cover change: the row, the sync push, and every window. */
function saveCover(db: DataDb, boardId: string, cover: HomePageCoverSync | null): HomePageRow {
  const row = updateHomePage(db, boardId, { cover })
  if (!row) throw new Error(`Home page ${boardId} not found`)
  enqueueHomePageUpdate(boardId)
  broadcastToAllWindows(HomePagesChannels.events.UPDATED, { id: boardId })
  return row
}

/** Deletes the board's cover files except `keep`; a stale file is disk only. */
async function pruneCoverFiles(vaultPath: string, boardId: string, keep: string | null) {
  const dir = coverDir(vaultPath, boardId)
  let names: string[]
  try {
    names = await readdir(dir)
  } catch {
    return
  }
  await Promise.all(
    names
      .filter((name) => path.join(dir, name) !== keep)
      .map((name) =>
        rm(path.join(dir, name), { force: true }).catch((error: unknown) =>
          log.warn('Could not delete an old board cover file', { boardId, error })
        )
      )
  )
}

type CoverBytes =
  | { ok: true; bytes: Buffer; filename: string; credit?: { name: string; url: string } }
  | { ok: false; reason: HomePageCoverFailure }

async function bytesFor(
  source: Exclude<HomePageCoverSource, { kind: 'wash' }>,
  deps: HomeCoverDeps
): Promise<CoverBytes> {
  switch (source.kind) {
    case 'upload':
      return {
        ok: true,
        bytes: Buffer.from(new Uint8Array(source.data)),
        filename: source.filename
      }
    case 'url':
      return fetchRemoteImage(source.url, deps)
    case 'unsplash':
      return fetchUnsplashPhoto(source.photo, deps)
    case 'vaultFile': {
      if (!isPlainSegment(source.ownerNoteId) || !isPlainSegment(source.filename)) {
        return { ok: false, reason: 'failed' }
      }
      const file = path.join(
        getNoteAttachmentsDir(deps.vaultPath, source.ownerNoteId),
        source.filename
      )
      try {
        return { ok: true, bytes: await readFile(file), filename: source.filename }
      } catch (error) {
        log.error('Could not read the vault image picked as a board cover', { error })
        return { ok: false, reason: 'failed' }
      }
    }
  }
}

/** One sync step per board and ref at a time; a second call while one runs is a no-op. */
const inFlight = new Set<string>()

/** Boards whose new image cover is written to disk but not yet to the row. */
const settingCover = new Set<string>()

export async function setHomeCover(
  boardId: string,
  source: HomePageCoverSource,
  deps: HomeCoverDeps
): Promise<SetHomeCoverResult> {
  if (!getHomePage(deps.db, boardId)) throw new Error(`Home page ${boardId} not found`)

  if (source.kind === 'wash') {
    if (!isCoverWashId(source.id)) return { ok: false, reason: 'failed' }
    const row = saveCover(deps.db, boardId, { ref: coverWashRef(source.id) })
    await pruneCoverFiles(deps.vaultPath, boardId, null)
    return { ok: true, row }
  }

  // Held from the file write to the row write, so a reconcile in between does not
  // prune a file the row does not name yet.
  settingCover.add(boardId)
  try {
    return await setImageCover(boardId, source, deps)
  } finally {
    settingCover.delete(boardId)
  }
}

async function setImageCover(
  boardId: string,
  source: Exclude<HomePageCoverSource, { kind: 'wash' }>,
  deps: HomeCoverDeps
): Promise<SetHomeCoverResult> {
  const fetched = await bytesFor(source, deps)
  if (!fetched.ok) return fetched
  if (!isAllowedFileType(fetched.filename)) return { ok: false, reason: 'not-an-image' }
  try {
    validateFileSize(fetched.bytes.length)
  } catch {
    return { ok: false, reason: 'too-large' }
  }

  const filename = generateUniqueFilename(fetched.filename)
  const ref = `${HOME_COVERS_DIR}/${boardId}/${filename}`
  const filePath = path.join(coverDir(deps.vaultPath, boardId), filename)
  try {
    await mkdir(path.dirname(filePath), { recursive: true })
    await atomicWriteBinary(filePath, fetched.bytes)
  } catch (error) {
    log.error('Could not write a board cover to the vault', { boardId, error })
    return { ok: false, reason: 'write-failed' }
  }

  const row = saveCover(deps.db, boardId, {
    ref,
    ...(fetched.credit ? { credit: fetched.credit.name, creditUrl: fetched.credit.url } : {})
  })
  await pruneCoverFiles(deps.vaultPath, boardId, filePath)
  void uploadCover(deps, boardId, ref, filePath)
  return { ok: true, row }
}

export function setHomeCoverFraming(
  db: DataDb,
  boardId: string,
  changes: FramingChanges
): HomePageRow {
  const board = getHomePage(db, boardId)
  if (!board) throw new Error(`Home page ${boardId} not found`)
  if (!board.cover) return board
  // Sent in full, defaults included, like a note's cover, so a receiver can read
  // an omission as an older sender rather than a reset.
  const current = {
    focusX: board.cover.focusX ?? DEFAULT_COVER_FRAMING.focusX,
    focusY: board.cover.focus ?? DEFAULT_COVER_FRAMING.focusY,
    zoom: board.cover.zoom ?? DEFAULT_COVER_FRAMING.zoom,
    height: board.cover.height ?? DEFAULT_COVER_FRAMING.height
  }
  const next = { ...current, ...changes }
  return saveCover(db, boardId, {
    ...board.cover,
    focus: clampCoverFocus(next.focusY),
    focusX: clampCoverFocus(next.focusX),
    zoom: clampCoverZoom(next.zoom),
    height: clampCoverHeight(next.height)
  })
}

export async function removeHomeCover(
  db: DataDb,
  vaultPath: string,
  boardId: string
): Promise<HomePageRow> {
  const row = saveCover(db, boardId, null)
  await pruneCoverFiles(vaultPath, boardId, null)
  return row
}

/** A deleted board's cover folder goes with it. No open vault, no folder to delete. */
export async function deleteHomeCoverFiles(boardId: string): Promise<void> {
  const vaultPath = getVaultStatus().path
  if (!vaultPath || !isPlainSegment(boardId)) return
  await rm(coverDir(vaultPath, boardId), { recursive: true, force: true }).catch((error: unknown) =>
    log.warn('Could not delete a board cover folder', { boardId, error })
  )
}

async function uploadCover(
  deps: Pick<HomeCoverDeps, 'db'>,
  boardId: string,
  ref: string,
  filePath: string
): Promise<void> {
  const key = `${boardId}\n${ref}`
  if (inFlight.has(key)) return
  const io = getCanvasAssetIO()
  if (!io) return // Sync is not running; the next reconcile uploads it.
  inFlight.add(key)
  try {
    const { attachmentId } = await io.uploadAttachment(boardId, filePath)
    // The user may have picked another cover while this one uploaded.
    const board = getHomePage(deps.db, boardId)
    if (board?.cover?.ref !== ref) return
    saveCover(deps.db, boardId, { ...board.cover, attachmentId })
  } catch (error) {
    log.warn('Board cover upload failed; the next reconcile retries it', { boardId, error })
  } finally {
    inFlight.delete(key)
  }
}

async function downloadCover(boardId: string, cover: HomePageCoverSync, filePath: string) {
  const key = `${boardId}\n${cover.ref}`
  if (inFlight.has(key) || !cover.attachmentId) return
  const io = getCanvasAssetIO()
  if (!io) return
  inFlight.add(key)
  try {
    await mkdir(path.dirname(filePath), { recursive: true })
    await io.downloadAttachment(cover.attachmentId, filePath)
    broadcastToAllWindows(HomePagesChannels.events.UPDATED, { id: boardId })
  } catch (error) {
    log.warn('Board cover download failed; the next reconcile retries it', { boardId, error })
  } finally {
    inFlight.delete(key)
  }
}

/**
 * Bring every board cover's bytes in line with its row: upload what only this
 * device has, download what only the account has. Safe to call at any time.
 */
export async function reconcileHomeCovers(
  deps: Pick<HomeCoverDeps, 'db' | 'vaultPath'>,
  boardId?: string
): Promise<void> {
  const boards = boardId
    ? [getHomePage(deps.db, boardId)].filter((b): b is HomePageRow => !!b)
    : listHomePages(deps.db)
  await Promise.all(
    boards.map(async (board) => {
      const cover = board.cover
      const filePath = cover ? homeCoverFilePath(deps.vaultPath, board.id, cover.ref) : null
      // A cover replaced or removed on another device leaves its old file here.
      if (!settingCover.has(board.id)) await pruneCoverFiles(deps.vaultPath, board.id, filePath)
      if (!cover || !filePath) return
      const present = await fileExists(filePath)
      if (present && !cover.attachmentId) await uploadCover(deps, board.id, cover.ref, filePath)
      else if (!present && cover.attachmentId) await downloadCover(board.id, cover, filePath)
    })
  )
}
