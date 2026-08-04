/**
 * The vault's Excalidraw library (shapes panel) as one plain file:
 * `<vault>/canvases/library.excalidrawlib`.
 *
 * Standard `excalidrawlib` format, so the same file opens in excalidraw.com and
 * survives a vault copy. Replaces the vault-key-encrypted
 * `canvas_library_items` rows, which died with the master key exactly like
 * canvas scenes did. Library items are not a sync type, so the file is the only
 * store — no index table is needed.
 *
 * @module canvas/library-file
 */

import path from 'path'

import type { CanvasLibraryItem } from '@memry/contracts/canvas-api'
import { createLogger } from '../lib/logger'
import {
  CANVAS_DIR,
  CANVAS_LIBRARY_FILE,
  readCanvasFileSync,
  resolveCanvasFile,
  writeCanvasFileSync
} from './scene-file'

const log = createLogger('CanvasLibraryFile')

interface LibraryFileShape {
  type?: string
  version?: number
  source?: string
  libraryItems?: unknown
}

export function libraryFileRelativePath(): string {
  return path.join(CANVAS_DIR, CANVAS_LIBRARY_FILE)
}

/**
 * Every library item in the vault. An unreadable or malformed file yields an
 * empty panel rather than a throw: a broken shapes library must never take the
 * canvas surface down with it.
 */
export function readCanvasLibrary(vaultPath: string): CanvasLibraryItem[] {
  const content = readCanvasFileSync(resolveCanvasFile(vaultPath, libraryFileRelativePath()))
  if (!content) return []
  try {
    const parsed = JSON.parse(content) as LibraryFileShape
    if (!Array.isArray(parsed.libraryItems)) return []
    return parsed.libraryItems as CanvasLibraryItem[]
  } catch (err) {
    log.error('Canvas library file is not readable JSON; showing an empty panel', { err })
    return []
  }
}

/**
 * Writes the full item list Excalidraw handed us. Returns true when the file
 * changed — Excalidraw saves on every library mutation, including ones that
 * only reorder in memory, so most saves are no-ops.
 */
export function writeCanvasLibrary(
  vaultPath: string,
  items: readonly CanvasLibraryItem[]
): boolean {
  const relativePath = libraryFileRelativePath()
  const next = JSON.stringify(
    {
      type: 'excalidrawlib',
      version: 2,
      source: 'memry',
      libraryItems: items
    },
    null,
    2
  )
  const absolute = resolveCanvasFile(vaultPath, relativePath)
  if (readCanvasFileSync(absolute) === next) return false
  writeCanvasFileSync(absolute, next)
  return true
}
