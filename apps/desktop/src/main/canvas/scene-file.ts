/**
 * File-backed canvas scenes — the source of truth for canvas ink.
 *
 * A canvas is a plain `.excalidraw` file inside the vault
 * (`<vault>/canvases/<Title>.excalidraw`), exactly like a note is a `.md` file.
 * Nothing here touches the vault key: a canvas must open after the vault folder
 * is copied to another machine (USB, git, Dropbox) and after the user upgrades
 * from local-only to a paid sync account, both of which replace the master key
 * and therefore orphaned every vault-key-encrypted snapshot (see
 * `reconcile.ts` for the one-way migration off the old encrypted column).
 *
 * The file stays a valid Excalidraw document — Excalidraw ignores unknown
 * top-level keys, so the `memry` sidecar (id + timestamps) rides along and
 * makes a single copied file self-describing. `stripCanvasMeta` removes it
 * again on the sync/comparison path so two devices never diff on metadata.
 *
 * Synchronous fs on purpose: the sync apply path writes scenes inside a
 * better-sqlite3 transaction, which cannot await.
 *
 * @module canvas/scene-file
 */

import { randomBytes } from 'crypto'
import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync
} from 'fs'
import path from 'path'

import { createLogger } from '../lib/logger'
import { sanitizeFilename } from '../vault/file-ops'

const log = createLogger('CanvasSceneFile')

/** Vault-relative directory holding canvas documents. */
export const CANVAS_DIR = 'canvases'
export const CANVAS_FILE_EXT = '.excalidraw'
/** Excalidraw's own library format, so the file opens in excalidraw.com too. */
export const CANVAS_LIBRARY_FILE = 'library.excalidrawlib'

/** The `memry` sidecar embedded in every canvas file. */
export interface CanvasFileMeta {
  id: string
  createdAt: number
  updatedAt: number
}

interface CanvasFileShape {
  type?: string
  version?: number
  source?: string
  elements?: unknown
  appState?: unknown
  files?: unknown
  memry?: CanvasFileMeta
}

const EMPTY_SCENE: CanvasFileShape = {
  type: 'excalidraw',
  version: 2,
  source: 'memry',
  elements: [],
  appState: {},
  files: {}
}

export function canvasDirPath(vaultPath: string): string {
  return path.join(vaultPath, CANVAS_DIR)
}

/**
 * Absolute path for a vault-relative canvas file path.
 *
 * Stored paths are ALWAYS forward-slashed (`canvases/Plan.excalidraw`), the
 * same convention as `lib/paths.normalizeRelativePath` for notes: a vault
 * written on Windows must open on macOS/Linux after a copy, and a `\`-joined
 * path resolves to a single bogus filename there. Split on `/` and re-join
 * natively so the separator is decided at read time, per platform.
 *
 * Also refuses to escape the vault: `file_path` comes out of a database that
 * may have been written by another device (or hand-edited), so a `..` segment
 * must not turn a canvas read into an arbitrary file read.
 */
export function resolveCanvasFile(vaultPath: string, relativePath: string): string {
  const segments = relativePath.split('/').filter((segment) => segment && segment !== '.')
  if (segments.some((segment) => segment === '..')) {
    throw new Error(`Canvas path escapes the vault: ${relativePath}`)
  }
  return path.join(vaultPath, ...segments)
}

/** Vault-relative (always forward-slashed) path inside the canvases directory. */
function canvasRelativePath(filename: string): string {
  return `${CANVAS_DIR}/${filename}`
}

/**
 * Embeds the memry sidecar into a serialized scene.
 *
 * A scene that is empty or unparseable still yields a valid Excalidraw
 * document: losing the ink to a parse error would be worse than writing an
 * empty canvas the user can draw on again.
 */
export function withCanvasMeta(scene: string, meta: CanvasFileMeta): string {
  let parsed: CanvasFileShape
  if (!scene.trim()) {
    parsed = { ...EMPTY_SCENE }
  } else {
    try {
      parsed = JSON.parse(scene) as CanvasFileShape
    } catch {
      log.warn('Canvas scene is not JSON; writing an empty document', { id: meta.id })
      parsed = { ...EMPTY_SCENE }
    }
  }
  return JSON.stringify(canonicalize(parsed, meta), null, 2)
}

/**
 * One canonical text per scene: fixed head keys, then every other top-level key
 * in sorted order. Two devices holding the same ink must emit the same bytes —
 * the sync conflict-copy check compares scenes as text, and a key-order wobble
 * would mint a "(conflict copy)" on every remote edit.
 *
 * Unknown keys are carried through untouched: `memryAssets` (the M5 image
 * sidecar) and anything Excalidraw adds later live up here, and dropping them
 * would quietly lose the canvas's images.
 */
function canonicalize(
  parsed: CanvasFileShape,
  meta: CanvasFileMeta | null
): Record<string, unknown> {
  const { type, version, source, elements, appState, files, memry: _memry, ...rest } = parsed
  const out: Record<string, unknown> = {
    type: type ?? EMPTY_SCENE.type,
    version: version ?? EMPTY_SCENE.version,
    source: source ?? EMPTY_SCENE.source
  }
  if (meta) out.memry = meta
  out.elements = elements ?? []
  out.appState = appState ?? {}
  out.files = files ?? {}
  for (const key of Object.keys(rest).sort()) {
    out[key] = (rest as Record<string, unknown>)[key]
  }
  return out
}

/**
 * The scene as the rest of the app (and sync) sees it — the file content minus
 * the memry sidecar. Two devices must produce byte-identical output for the
 * same ink, otherwise the conflict-copy comparison mints spurious copies.
 */
export function stripCanvasMeta(content: string): string {
  if (!content.trim()) return ''
  let parsed: CanvasFileShape
  try {
    parsed = JSON.parse(content) as CanvasFileShape
  } catch {
    return content
  }
  return JSON.stringify(canonicalize(parsed, null))
}

export function readCanvasMeta(content: string): CanvasFileMeta | null {
  try {
    const parsed = JSON.parse(content) as CanvasFileShape
    const meta = parsed.memry
    if (!meta || typeof meta.id !== 'string' || !meta.id) return null
    return {
      id: meta.id,
      createdAt: typeof meta.createdAt === 'number' ? meta.createdAt : Date.now(),
      updatedAt: typeof meta.updatedAt === 'number' ? meta.updatedAt : Date.now()
    }
  } catch {
    return null
  }
}

export function ensureCanvasDir(vaultPath: string): void {
  mkdirSync(canvasDirPath(vaultPath), { recursive: true })
}

/**
 * Windows locks files while a cloud-sync client or antivirus scanner touches
 * them, so a write/rename/delete that just failed often succeeds a moment
 * later. Same codes and backoff as `vault/file-ops.withTransientFsRetry`, but
 * synchronous: the sync apply path writes scenes inside a better-sqlite3
 * transaction, which cannot await. `Atomics.wait` is the only real sleep
 * available on this thread; it runs at most three times, only after a failure.
 */
const TRANSIENT_FS_ERROR_CODES = new Set(['EBUSY', 'EPERM', 'EACCES'])
const TRANSIENT_FS_RETRY_DELAYS_MS = [50, 150, 450]
const sleepBuffer = new Int32Array(new SharedArrayBuffer(4))

function sleepSync(ms: number): void {
  Atomics.wait(sleepBuffer, 0, 0, ms)
}

function withTransientFsRetrySync<T>(operation: () => T, operationName: string): T {
  for (const [index, delayMs] of TRANSIENT_FS_RETRY_DELAYS_MS.entries()) {
    try {
      return operation()
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code ?? ''
      if (!TRANSIENT_FS_ERROR_CODES.has(code)) throw err
      // Errno and attempt only — never the path, which is title-derived.
      log.warn(
        `${operationName}: transient ${code} on attempt ${index + 1} of ` +
          `${TRANSIENT_FS_RETRY_DELAYS_MS.length + 1}, retrying in ${delayMs}ms`
      )
      sleepSync(delayMs)
    }
  }
  return operation()
}

/**
 * Atomic write (unique temp file + rename + fsync), mirroring
 * vault/file-ops.atomicWrite — a half-written scene is a lost canvas.
 *
 * The temp name is random and opened `wx` with owner-only permissions: a
 * predictable name in a user-writable directory is a symlink-swap target, and
 * a leftover temp from a crashed run must not be reused. Rename overwrites the
 * target on all three platforms (libuv passes MOVEFILE_REPLACE_EXISTING on
 * Windows).
 */
export function writeCanvasFileSync(absolutePath: string, content: string): void {
  mkdirSync(path.dirname(absolutePath), { recursive: true })
  withTransientFsRetrySync(() => {
    // Fresh temp per attempt so a failed attempt cannot collide with its own
    // leftovers on retry.
    const tmp = path.join(path.dirname(absolutePath), `.${randomBytes(6).toString('hex')}.tmp`)
    try {
      writeFileSync(tmp, content, { encoding: 'utf-8', mode: 0o600, flag: 'wx' })
      const fd = openSync(tmp, 'r+')
      try {
        fsyncSync(fd)
      } finally {
        closeSync(fd)
      }
      renameSync(tmp, absolutePath)
    } catch (err) {
      try {
        if (existsSync(tmp)) unlinkSync(tmp)
      } catch {
        // Cleanup is best effort; the original error is what matters.
      }
      throw err
    }
  }, 'writeCanvasFile')
}

export function readCanvasFileSync(absolutePath: string): string | null {
  try {
    return withTransientFsRetrySync(() => readFileSync(absolutePath, 'utf-8'), 'readCanvasFile')
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code
    // ENOENT is the "no document" answer the callers expect. ENOTDIR/EISDIR
    // mean the path no longer names a file (a folder took its place after a
    // copy) — report it the same way rather than taking the surface down.
    if (code === 'ENOENT' || code === 'ENOTDIR' || code === 'EISDIR') return null
    throw err
  }
}

export function deleteCanvasFileSync(absolutePath: string): void {
  try {
    withTransientFsRetrySync(() => unlinkSync(absolutePath), 'deleteCanvasFile')
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      log.warn('Could not delete canvas file', { code: (err as NodeJS.ErrnoException).code })
    }
  }
}

/** Vault-relative paths of every canvas document, sorted for stable adoption. */
export function listCanvasFiles(vaultPath: string): string[] {
  const dir = canvasDirPath(vaultPath)
  if (!existsSync(dir)) return []
  return readdirSync(dir)
    .filter((name) => name.toLowerCase().endsWith(CANVAS_FILE_EXT))
    .sort()
    .map((name) => canvasRelativePath(name))
}

/**
 * Windows refuses these as filenames whatever the extension (`CON.excalidraw`
 * fails just like `CON`), and they are perfectly ordinary canvas titles.
 * Suffixed rather than replaced so the user still recognizes the file.
 */
const WINDOWS_RESERVED_NAMES = /^(con|prn|aux|nul|com[0-9¹²³]|lpt[0-9¹²³])$/i

/**
 * A filename every platform accepts. `sanitizeFilename` already strips the
 * characters Windows and Obsidian forbid; this adds the two rules that bite
 * only on Windows — reserved device names, and trailing dots/spaces, which
 * Win32 silently trims (so `Plan.` and `Plan ` would both resolve to `Plan`
 * and quietly collide).
 */
function portableCanvasBase(title: string | null): string {
  let base = sanitizeFilename(title?.trim() || 'Canvas') || 'Canvas'
  base = base.replace(/[. ]+$/, '')
  if (!base) base = 'Canvas'
  if (WINDOWS_RESERVED_NAMES.test(base)) base = `${base} canvas`
  return base
}

/**
 * Vault-relative path for a canvas title, uniquified against what is already on
 * disk. `taken` carries paths claimed earlier in the same batch (adoption,
 * migration) that are not written out yet.
 *
 * Collisions are compared case-INSENSITIVELY: macOS and Windows both default to
 * case-insensitive filesystems, so "Plan" and "plan" are one file there. Taking
 * the stricter rule everywhere keeps a vault portable — a pair of canvases that
 * coexist on Linux must not merge into one when the folder is copied to a Mac.
 */
export function allocateCanvasPath(
  vaultPath: string,
  title: string | null,
  taken: ReadonlySet<string> = new Set(),
  /**
   * The canvas's own current path, if it has one. Without it a title edit that
   * only changes case ("Plan" → "plan") collides with the canvas's own file on
   * macOS/Windows and lands on "plan 2".
   */
  current: string | null = null
): string {
  const base = portableCanvasBase(title)
  const claimed = new Set([...taken].map((entry) => entry.toLowerCase()))
  const own = current?.toLowerCase() ?? null
  let candidate = canvasRelativePath(`${base}${CANVAS_FILE_EXT}`)
  let counter = 1
  while (
    candidate.toLowerCase() !== own &&
    (claimed.has(candidate.toLowerCase()) || existsSync(resolveCanvasFile(vaultPath, candidate)))
  ) {
    counter += 1
    candidate = canvasRelativePath(`${base} ${counter}${CANVAS_FILE_EXT}`)
  }
  return candidate
}

/**
 * Moves a canvas file after a title change. Best-effort: a failed rename keeps
 * the old path (returned) rather than losing the file — the title in the index
 * is cosmetic, the ink is not.
 */
export function renameCanvasFile(vaultPath: string, from: string, to: string): string {
  if (from === to) return from
  const fromAbs = resolveCanvasFile(vaultPath, from)
  const toAbs = resolveCanvasFile(vaultPath, to)
  try {
    mkdirSync(path.dirname(toAbs), { recursive: true })
    withTransientFsRetrySync(() => renameSync(fromAbs, toAbs), 'renameCanvasFile')
    return to
  } catch (err) {
    log.warn('Could not rename canvas file; keeping the previous path', {
      code: (err as NodeJS.ErrnoException).code
    })
    return from
  }
}
