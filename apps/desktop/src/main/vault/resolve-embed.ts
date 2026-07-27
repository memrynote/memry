/**
 * Resolve Obsidian image embeds (`![[photo.png]]`) to loadable URLs.
 *
 * The editor renders images through the `memry-file://` protocol and only ever
 * resolves absolute URLs — a bare `photo.png` would resolve against the renderer
 * origin and render broken. Obsidian writes embeds either as a vault-relative
 * path (`Images/photo.png`) or as a bare filename it looks up across the whole
 * vault, so both forms have to map back to an absolute path here.
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
 * Look a bare filename up in the index, which already carries every non-markdown
 * file in the vault (`indexBinaryFile`). Paths are vault-relative.
 */
function lookupByFilename(vaultPath: string, filename: string): string | null {
  try {
    const db = getIndexDatabase()
    const rows = db
      .select({ path: noteCache.path })
      .from(noteCache)
      .where(eq(noteCache.fileType, 'image'))
      .all()

    // Several folders can hold the same filename; Obsidian picks the shortest
    // path, which is also the least surprising answer here.
    const matches = rows
      .map((row) => row.path)
      .filter((p) => path.basename(p).toLowerCase() === filename.toLowerCase())
      .sort((a, b) => a.split('/').length - b.split('/').length || a.localeCompare(b))

    const match = matches[0]
    if (!match) return null

    const absPath = path.resolve(vaultPath, match)
    return isInsideVault(vaultPath, absPath) && fs.existsSync(absPath) ? absPath : null
  } catch (error) {
    logger.warn('index lookup failed', { filename, error })
    return null
  }
}

/**
 * Resolve one embed target to a `memry-file://` URL, or null when the vault is
 * closed or nothing matches.
 */
export function resolveVaultEmbed(ref: string): string | null {
  const status = getStatus()
  if (!status.isOpen || !status.path) return null
  const vaultPath = status.path

  // A URL or an absolute path is not ours to resolve.
  if (/^[a-zA-Z][a-zA-Z\d+\-.]*:/.test(ref) || path.isAbsolute(ref)) return null

  const notesFolder = getConfig().defaultNoteFolder || 'notes'

  for (const candidate of candidatePaths(vaultPath, notesFolder, ref)) {
    if (!isInsideVault(vaultPath, candidate)) continue
    if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) {
      return encodeAttachmentUrl(toMemryFileUrl(candidate))
    }
  }

  const byName = lookupByFilename(vaultPath, path.basename(ref))
  return byName ? encodeAttachmentUrl(toMemryFileUrl(byName)) : null
}

/**
 * Batch form used by the note-parse path: one call resolves every embed in a
 * note, so opening a note costs a single round trip instead of one per image.
 * Unresolvable targets are omitted rather than mapped to null.
 */
export function resolveVaultEmbeds(refs: string[]): Record<string, string> {
  const resolved: Record<string, string> = {}
  for (const ref of refs) {
    const url = resolveVaultEmbed(ref)
    if (url) resolved[ref] = url
  }
  return resolved
}
