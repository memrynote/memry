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

/** Absolute path for a vault-relative canvas file path. */
export function resolveCanvasFile(vaultPath: string, relativePath: string): string {
  return path.join(vaultPath, relativePath)
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
 * Atomic write (tmp + rename + fsync), mirroring vault/file-ops.atomicWrite —
 * a half-written scene is a lost canvas.
 */
export function writeCanvasFileSync(absolutePath: string, content: string): void {
  mkdirSync(path.dirname(absolutePath), { recursive: true })
  const tmp = `${absolutePath}.${process.pid}.tmp`
  writeFileSync(tmp, content, 'utf-8')
  const fd = openSync(tmp, 'r+')
  try {
    fsyncSync(fd)
  } finally {
    closeSync(fd)
  }
  renameSync(tmp, absolutePath)
}

export function readCanvasFileSync(absolutePath: string): string | null {
  try {
    return readFileSync(absolutePath, 'utf-8')
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw err
  }
}

export function deleteCanvasFileSync(absolutePath: string): void {
  try {
    unlinkSync(absolutePath)
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      log.warn('Could not delete canvas file', { absolutePath, err })
    }
  }
}

/** Vault-relative paths of every canvas document, sorted for stable adoption. */
export function listCanvasFiles(vaultPath: string): string[] {
  const dir = canvasDirPath(vaultPath)
  if (!existsSync(dir)) return []
  return readdirSync(dir)
    .filter((name) => name.endsWith(CANVAS_FILE_EXT))
    .sort()
    .map((name) => path.join(CANVAS_DIR, name))
}

/**
 * Vault-relative path for a canvas title, uniquified against what is already on
 * disk. `taken` carries paths claimed earlier in the same batch (adoption,
 * migration) that are not written out yet.
 */
export function allocateCanvasPath(
  vaultPath: string,
  title: string | null,
  taken: ReadonlySet<string> = new Set()
): string {
  const base = sanitizeFilename(title?.trim() || 'Canvas') || 'Canvas'
  let candidate = path.join(CANVAS_DIR, `${base}${CANVAS_FILE_EXT}`)
  let counter = 1
  while (taken.has(candidate) || existsSync(resolveCanvasFile(vaultPath, candidate))) {
    counter += 1
    candidate = path.join(CANVAS_DIR, `${base} ${counter}${CANVAS_FILE_EXT}`)
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
    renameSync(fromAbs, toAbs)
    return to
  } catch (err) {
    log.warn('Could not rename canvas file; keeping the previous path', { from, to, err })
    return from
  }
}
