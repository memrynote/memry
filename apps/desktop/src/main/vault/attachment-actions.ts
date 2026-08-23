/**
 * Reveal / open / resolve actions for attachment blocks (file, image).
 *
 * A block's `props.url` comes in two shapes: note-relative
 * (`../attachments/<noteId>/<file>`, written since attachments went relative)
 * and legacy absolute (`memry-file://local/<abs path>`, written before that —
 * possibly by another device, so the absolute path may not exist here).
 * Both resolve to a path inside this device's vault or the call is rejected;
 * the caller can never hand an arbitrary filesystem path to the OS shell.
 */

import { existsSync } from 'fs'
import path from 'path'
import { shell } from 'electron'
import type { AttachmentResolveResult } from '@memry/contracts/notes-api'
import { getNoteCacheById } from '@main/database/queries/notes'
import { getIndexDatabase } from '../database'
import { NoteError, NoteErrorCode } from '../lib/errors'
import { fromMemryFileUrl, isPathInVault } from '../lib/paths'
import { remapCrossDeviceAttachmentPath } from '../lib/attachment-path-remap'
import { getVaultRoot } from './notes-io'

const MEMRY_FILE_PREFIX = 'memry-file://local/'
const HAS_SCHEME = /^[a-zA-Z][a-zA-Z\d+\-.]*:/
const SEPARATOR = /[/\\]/

/**
 * Join a vault-relative directory with a relative ref, collapsing `.` and `..`.
 * Returns null if the ref climbs above the vault root. Mirrors the renderer's
 * `resolve-note-relative-url.ts` — restated because that module is not
 * importable from main; both sides are covered by tests over the same cases.
 */
function joinWithinVault(dir: string, ref: string): string | null {
  const out: string[] = []
  for (const segment of [...dir.split(SEPARATOR), ...ref.split(SEPARATOR)]) {
    if (!segment || segment === '.') continue
    if (segment === '..') {
      if (out.length === 0) return null
      out.pop()
      continue
    }
    out.push(segment)
  }
  return out.length > 0 ? out.join('/') : null
}

function resolveLegacyAbsoluteUrl(url: string, vaultPath: string, noteId: string): string {
  const requested = fromMemryFileUrl(url)
  if (isPathInVault(vaultPath, requested)) return requested

  // Written on another machine: same vault-relative location, different root.
  const remapped = remapCrossDeviceAttachmentPath(requested, [vaultPath])
  if (remapped) return remapped

  // Not on disk yet (or never an attachment path at all) — derive the local
  // candidate from the `attachments/…` tail so the caller still gets a path
  // to show, with `exists: false`. Same tail validation as the remap helper.
  const normalized = requested.replace(/\\/g, '/')
  const idx = normalized.lastIndexOf('/attachments/')
  if (idx !== -1) {
    const segments = normalized
      .slice(idx + '/attachments/'.length)
      .split('/')
      .filter((s) => s.length > 0)
    if (segments.length > 0 && !segments.some((s) => s === '.' || s === '..')) {
      return path.resolve(vaultPath, 'attachments', ...segments)
    }
  }

  throw new NoteError('Attachment path is outside the vault', NoteErrorCode.INVALID_PATH, noteId)
}

export function resolveAttachment(noteId: string, url: string): AttachmentResolveResult {
  const cached = getNoteCacheById(getIndexDatabase(), noteId)
  if (!cached) {
    throw new NoteError(`Note not found: ${noteId}`, NoteErrorCode.NOT_FOUND, noteId)
  }

  const vaultPath = getVaultRoot()
  let absolutePath: string

  if (url.startsWith(MEMRY_FILE_PREFIX)) {
    absolutePath = resolveLegacyAbsoluteUrl(url, vaultPath, noteId)
  } else if (HAS_SCHEME.test(url) || url.startsWith('/') || url.startsWith('\\')) {
    // http(s):, data:, an absolute filesystem path… — not a vault attachment.
    throw new NoteError(
      'Attachment url is not a vault-relative path',
      NoteErrorCode.INVALID_PATH,
      noteId
    )
  } else {
    // Refs are commonly percent-encoded (`my%20file.pdf`).
    let decoded: string
    try {
      decoded = decodeURIComponent(url)
    } catch {
      decoded = url
    }

    const lastSlash = cached.path.lastIndexOf('/')
    const noteDir = lastSlash === -1 ? '' : cached.path.slice(0, lastSlash)
    const resolved = joinWithinVault(noteDir, decoded)
    if (!resolved) {
      throw new NoteError('Attachment path escapes the vault', NoteErrorCode.INVALID_PATH, noteId)
    }
    absolutePath = path.join(vaultPath, resolved)
  }

  return {
    absolutePath,
    storedFilename: path.basename(absolutePath),
    exists: existsSync(absolutePath)
  }
}

export function revealAttachmentInFinder(noteId: string, url: string): void {
  const resolved = resolveAttachment(noteId, url)
  if (!resolved.exists) {
    throw new NoteError('Attachment file not found on disk', NoteErrorCode.NOT_FOUND, noteId)
  }
  shell.showItemInFolder(resolved.absolutePath)
}

export async function openAttachmentExternal(noteId: string, url: string): Promise<void> {
  const resolved = resolveAttachment(noteId, url)
  if (!resolved.exists) {
    throw new NoteError('Attachment file not found on disk', NoteErrorCode.NOT_FOUND, noteId)
  }
  await shell.openPath(resolved.absolutePath)
}
