/**
 * Carry an exported note's images inside the exported document.
 *
 * PDF export loads the rendered HTML through a `data:text/html` URL, which has
 * an opaque origin and no base URL, so a relative `<img src="attachments/…">`
 * has nothing to resolve against and `printToPDF` bakes in a broken image
 * (#1935). HTML export only looked right because the file happened to land next
 * to the attachments; move the `.html` and it breaks the same way.
 *
 * Inlining the bytes fixes both paths with one rule. It needs no base URL and
 * no script, so it works with `webPreferences.javascript: false`, and it makes
 * an exported `.html` self-contained. The cost is document size: every image is
 * carried as base64, about a third larger than the file on disk.
 *
 * @module lib/export-image-inliner
 */

import { readFile } from 'fs/promises'
import path from 'path'
import { fileURLToPath } from 'url'
import { getExtension, getMimeType } from '@memry/shared/file-types'
import { createLogger } from './logger'

const logger = createLogger('ExportImageInliner')

export interface ExportImageSource {
  /** The exported note's vault-relative path, e.g. `Folder/Note.md`. */
  notePath?: string
  /** Absolute path of the open vault. */
  vaultPath?: string | null
}

const IMG_TAG = /<img\b[^>]*>/gi
const SRC_ATTR = /(\ssrc\s*=\s*)(["'])([^"']*)\2/i

/** `https:`, `data:`, `memry-file:` — and `C:` on Windows, ruled out first. */
const HAS_SCHEME = /^[a-zA-Z][a-zA-Z\d+\-.]*:/
const WINDOWS_DRIVE = /^[a-zA-Z]:[/\\]/
const SEPARATOR = /[/\\]/

/**
 * Join the note's vault-relative directory with a relative ref, collapsing `.`
 * and `..`. Returns null when the ref climbs above the vault root.
 *
 * Restated from the renderer's `resolve-note-relative-url.ts` rather than
 * imported: the renderer is not importable here, and both sides have to agree
 * on what a note-relative ref means or the export resolves images the editor
 * does not.
 */
function joinWithinVault(dir: string, ref: string): string[] | null {
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
  return out.length > 0 ? out : null
}

function memryFileUrlToPath(url: string): string | null {
  try {
    const decoded = decodeURIComponent(new URL(url).pathname)
    if (process.platform === 'win32') {
      return decoded.startsWith('/') ? decoded.slice(1) : decoded
    }
    return decoded.startsWith('/') ? decoded : `/${decoded}`
  } catch {
    return null
  }
}

/**
 * The on-disk file an `<img src>` names, or null when the src is not a local
 * file we should read: a remote or already-inlined URL, an unknown scheme, or a
 * relative ref that escapes the vault.
 */
function resolveLocalPath(src: string, source: ExportImageSource): string | null {
  const ref = src.trim()
  if (!ref) return null
  if (WINDOWS_DRIVE.test(ref)) return ref

  if (HAS_SCHEME.test(ref)) {
    const scheme = ref.slice(0, ref.indexOf(':')).toLowerCase()
    if (scheme === 'file') {
      try {
        return fileURLToPath(ref)
      } catch {
        return null
      }
    }
    if (scheme === 'memry-file') return memryFileUrlToPath(ref)
    return null
  }

  if (ref.startsWith('/') || ref.startsWith('\\')) return ref

  const { notePath, vaultPath } = source
  if (!notePath || !vaultPath) return null

  let decoded: string
  try {
    decoded = decodeURIComponent(ref)
  } catch {
    decoded = ref
  }

  const noteDir = notePath.split(SEPARATOR).slice(0, -1).join('/')
  const segments = joinWithinVault(noteDir, decoded)
  if (!segments) return null

  return path.join(vaultPath, ...segments)
}

/**
 * Rewrite every `<img src>` in a rendered note to a `data:` URI holding the
 * file's bytes. A src that names no readable local file is left as written.
 */
export async function inlineExportImages(html: string, source: ExportImageSource): Promise<string> {
  const refs = new Set<string>()
  for (const tag of html.match(IMG_TAG) ?? []) {
    const src = SRC_ATTR.exec(tag)?.[3]
    if (src) refs.add(src)
  }
  if (refs.size === 0) return html

  const inlined = new Map<string, string>()
  await Promise.all(
    [...refs].map(async (src) => {
      const filePath = resolveLocalPath(src, source)
      if (!filePath) return
      try {
        const bytes = await readFile(filePath)
        const mime = getMimeType(getExtension(filePath)) ?? 'application/octet-stream'
        inlined.set(src, `data:${mime};base64,${bytes.toString('base64')}`)
      } catch (error) {
        logger.warn('Export could not inline an image, leaving the reference as written', {
          src,
          filePath,
          error
        })
      }
    })
  )
  if (inlined.size === 0) return html

  return html.replace(IMG_TAG, (tag) =>
    tag.replace(SRC_ATTR, (attribute: string, prefix: string, quote: string, src: string) => {
      const dataUri = inlined.get(src)
      return dataUri ? `${prefix}${quote}${dataUri}${quote}` : attribute
    })
  )
}
