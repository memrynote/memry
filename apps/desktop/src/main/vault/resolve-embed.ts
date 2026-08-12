/**
 * Resolve Obsidian image embeds (`![[photo.png]]`) to something the editor can
 * load. Obsidian writes embeds either as a vault-relative path
 * (`Images/photo.png`) or as a bare filename it looks up across the whole vault,
 * so both forms have to map back to a real file here.
 *
 * **Two output shapes, and the difference matters.** The rewrite is spliced into
 * the note's markdown before parsing, so whatever this returns is what
 * `blocksToMarkdownLossy` writes back to the vault file on the next save:
 *
 *  - Given the note's own path, it returns a path **relative to that note** —
 *    which survives the round trip, stays valid in Obsidian, and carries no
 *    machine-specific prefix into a file that syncs to other devices.
 *  - Without a note path it falls back to an absolute `memry-file://` URL. Only
 *    read-only surfaces (canvas note previews) are in that position; they render
 *    the markdown and throw it away, so nothing is ever persisted.
 *
 * Targets that cannot be found resolve to nothing on purpose: the caller leaves
 * the embed as written rather than rewriting it into a broken image.
 */

import * as fs from 'fs'
import * as path from 'path'
import { eq } from 'drizzle-orm'
import { noteCache } from '@memry/db-schema/schema/notes-cache'
import { getIndexDatabase } from '../database'
import { toMemryFileUrl } from '../lib/paths'
// Same encoding the importers apply: the resolved URL is spliced into markdown
// as `![alt](url)`, where a raw space or paren truncates the link.
import { encodeAttachmentUrl } from '../import/_shared/attachment-markdown'
import { createLogger } from '../lib/logger'
import { getStatus, getConfig } from './index'

const logger = createLogger('ResolveEmbed')

/** Refuse anything that climbs out of the vault once resolved. */
function isInsideVault(vaultPath: string, absPath: string): boolean {
  const rel = path.relative(vaultPath, absPath)
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel)
}

/**
 * Absolute paths an embed target could name, most specific first: as written
 * from the vault root, then from the notes folder (where Obsidian vaults
 * imported into Memry keep their notes).
 */
function candidatePaths(vaultPath: string, notesFolder: string, ref: string): string[] {
  return [path.resolve(vaultPath, ref), path.resolve(vaultPath, notesFolder, ref)]
}

/**
 * Look bare filenames up in the index, which already carries every non-markdown
 * file in the vault (`indexBinaryFile`). Paths are vault-relative.
 *
 * Takes the whole batch at once: the query has no filename predicate to push
 * down (`note_cache` stores full paths, not basenames), so running it per ref
 * re-read every image row in the vault once per embed. Keys are lowercased
 * filenames, matching how the caller looks them up.
 */
function lookupByFilenames(vaultPath: string, filenames: Set<string>): Map<string, string> {
  const found = new Map<string, string>()
  if (filenames.size === 0) return found

  try {
    const db = getIndexDatabase()
    const rows = db
      .select({ path: noteCache.path })
      .from(noteCache)
      .where(eq(noteCache.fileType, 'image'))
      .all()

    const byName = new Map<string, string[]>()
    for (const row of rows) {
      const name = path.basename(row.path).toLowerCase()
      if (!filenames.has(name)) continue
      const paths = byName.get(name)
      if (paths) paths.push(row.path)
      else byName.set(name, [row.path])
    }

    for (const [name, paths] of byName) {
      // Several folders can hold the same filename; Obsidian picks the shortest
      // path, which is also the least surprising answer here.
      paths.sort((a, b) => a.split('/').length - b.split('/').length || a.localeCompare(b))

      const absPath = path.resolve(vaultPath, paths[0])
      if (isInsideVault(vaultPath, absPath) && fs.existsSync(absPath)) found.set(name, absPath)
    }
  } catch (error) {
    logger.warn('index lookup failed', { filenames: [...filenames], error })
  }

  return found
}

/**
 * Render the resolved file the way the note should carry it: relative to the
 * note when we know where the note lives, absolute otherwise. Forward slashes
 * always — this goes into markdown, not onto a Windows command line.
 */
function embedTarget(vaultPath: string, absPath: string, notePath?: string): string {
  if (!notePath) return encodeAttachmentUrl(toMemryFileUrl(absPath))

  const noteDir = path.dirname(path.resolve(vaultPath, notePath))
  const relative = path.relative(noteDir, absPath).split(path.sep).join('/')
  // `path.relative` returns '' for the directory itself and an absolute path
  // across Windows drives; neither is a usable ref.
  if (!relative || path.isAbsolute(relative)) {
    return encodeAttachmentUrl(toMemryFileUrl(absPath))
  }
  return encodeAttachmentUrl(relative)
}

/** The file on disk an embed target names, or null when nothing is there. */
function findOnDisk(vaultPath: string, notesFolder: string, ref: string): string | null {
  for (const candidate of candidatePaths(vaultPath, notesFolder, ref)) {
    if (!isInsideVault(vaultPath, candidate)) continue
    if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) return candidate
  }
  return null
}

/**
 * Resolve a batch against one already-read vault path and notes folder. Refs
 * that miss on disk are collected and handed to the index in a single lookup,
 * which is skipped entirely when everything was found on disk.
 */
function resolveAgainstVault(
  vaultPath: string,
  notesFolder: string,
  refs: string[],
  notePath?: string
): Record<string, string> {
  const resolved: Record<string, string> = {}
  const pending = new Map<string, string>()

  for (const ref of refs) {
    // A URL or an absolute path is not ours to resolve.
    if (/^[a-zA-Z][a-zA-Z\d+\-.]*:/.test(ref) || path.isAbsolute(ref)) continue

    const onDisk = findOnDisk(vaultPath, notesFolder, ref)
    if (onDisk) resolved[ref] = embedTarget(vaultPath, onDisk, notePath)
    else pending.set(ref, path.basename(ref).toLowerCase())
  }

  const byName = lookupByFilenames(vaultPath, new Set(pending.values()))
  for (const [ref, filename] of pending) {
    const absPath = byName.get(filename)
    if (absPath) resolved[ref] = embedTarget(vaultPath, absPath, notePath)
  }

  return resolved
}

/**
 * Resolve one embed target, or null when the vault is closed or nothing matches.
 * See the module comment for why `notePath` changes the shape of the result.
 */
export function resolveVaultEmbed(ref: string, notePath?: string): string | null {
  const resolved = resolveVaultEmbeds([ref], notePath)
  // Plain `resolved[ref]` would read through the prototype for a ref like `__proto__`.
  return Object.prototype.hasOwnProperty.call(resolved, ref) ? resolved[ref] : null
}

/**
 * Batch form used by the note-parse path: one call resolves every embed in a
 * note, so opening a note costs a single round trip instead of one per image.
 * Unresolvable targets are omitted rather than mapped to null.
 */
export function resolveVaultEmbeds(refs: string[], notePath?: string): Record<string, string> {
  const status = getStatus()
  if (!status.isOpen || !status.path) return {}

  // Read once per batch, not once per ref: `getConfig` no longer re-parses
  // config.json — the parse is cached — but every call still stats the file to
  // revalidate that cache and rebuilds the config object it hands back. Reading
  // it once also pins one notes folder for the whole batch, so a config change
  // landing mid-resolve cannot send half a note's embeds to the old folder and
  // half to the new one.
  const notesFolder = getConfig().defaultNoteFolder || 'notes'

  return resolveAgainstVault(status.path, notesFolder, refs, notePath)
}
