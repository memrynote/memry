import { Readable } from 'node:stream'
import type { FileHandle } from 'node:fs/promises'
import path from 'node:path'
import { lookup as mimeLookup } from 'mime-types'
import { toErrorCode } from '@memry/contracts/telemetry-api'
import { trackMainLog } from '../telemetry/diagnostics'
import { healAttachmentPath } from '../vault/attachment-heal'
import { isHtmlEmbedPath } from '../vault/html-embed-protocol'
import { remapCrossDeviceAttachmentPath } from './attachment-path-remap'
import { OutsideVaultError } from './errors'
import { isPathInsideDirs, resolveMemryFilePath } from './external-url'
import { createLogger } from './logger'
import { openVaultFile } from './paths'

const mainLog = createLogger('Main')

const IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp'])

// 1x1 transparent PNG for missing images (null thumbnails), instead of a broken-image icon.
const TRANSPARENT_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=',
  'base64'
)

/** Opens an allowed path through `openVaultFile` under the root that contains it. */
function openUnderRoot(filePath: string, roots: string[]): Promise<FileHandle | null> {
  const root = roots.find((dir) => isPathInsideDirs(filePath, [dir]))
  if (root === undefined) return Promise.resolve(null)
  return openVaultFile(root, path.relative(root, filePath))
}

/**
 * The `memry-file://` protocol: serves vault and userData files to the renderer.
 * Each request opens the file once through `openVaultFile` and reads only from
 * that handle, so a file linked outside its root, or swapped for such a link
 * after the check, is refused with 403 instead of served.
 */
export async function serveMemryFile(
  request: Request,
  userDataPath: string,
  rawVaultPaths: ReadonlyArray<string | null | undefined>
): Promise<Response> {
  let filePath = resolveMemryFilePath(request.url)
  if (filePath === null) return new Response(null, { status: 404, statusText: 'Not Found' })

  const vaultPaths = rawVaultPaths.filter((vaultPath): vaultPath is string => Boolean(vaultPath))
  const roots = [...new Set([...vaultPaths, userDataPath].map((dir) => path.resolve(dir)))]

  if (!isPathInsideDirs(filePath, roots)) {
    // Note blocks store the ORIGIN machine's absolute path (memry-file://local/<abs>),
    // so a note synced from another device points at a path that doesn't exist
    // here. The bytes live at the same attachments/<noteId>/<file> spot inside
    // this device's vault — serve from there when present.
    const remapped = remapCrossDeviceAttachmentPath(filePath, vaultPaths)
    if (!remapped) {
      mainLog.warn('memry-file: blocked path outside allowed directories', { filePath })
      return new Response(null, { status: 403, statusText: 'Forbidden' })
    }
    mainLog.debug('memry-file: remapped cross-device attachment path', {
      requested: filePath,
      remapped
    })
    filePath = remapped
  }

  let handle: FileHandle | null
  try {
    handle = await openUnderRoot(filePath, roots)
    if (handle === null) {
      // Self-heal (#1713): an attachment renamed on disk outside the app is
      // served from its unique prefix/suffix match in the same note's folder.
      // The note is never rewritten — each device heals against its own disk
      // (see vault/attachment-heal.ts). Runs before the transparent-PNG
      // fallback so renamed images heal instead of rendering as 1x1 blanks.
      const healed = healAttachmentPath(filePath, vaultPaths)
      if (healed) {
        mainLog.debug('memry-file: healed renamed attachment', { requested: filePath, healed })
        filePath = healed
        handle = await openUnderRoot(filePath, roots)
      }
    }
  } catch (error) {
    if (error instanceof OutsideVaultError) {
      mainLog.warn('memry-file: refused file linked outside its root', { filePath })
      return new Response(null, { status: 403, statusText: 'Forbidden' })
    }
    return serveFailed(error)
  }

  if (handle === null) {
    if (IMAGE_EXTENSIONS.has(path.extname(filePath).toLowerCase())) {
      return new Response(TRANSPARENT_PNG, {
        status: 200,
        headers: { 'Content-Type': 'image/png' }
      })
    }
    return new Response(null, { status: 404, statusText: 'Not Found' })
  }

  try {
    return await serveFromHandle(handle, filePath, request.headers.get('Range'))
  } catch (error) {
    await handle.close().catch(() => undefined)
    return serveFailed(error)
  }
}

/** Serves the opened file; a full-file body closes the handle when the stream ends. */
async function serveFromHandle(
  handle: FileHandle,
  filePath: string,
  rangeHeader: string | null
): Promise<Response> {
  const fileSize = (await handle.stat()).size

  // Never let an attached HTML file render as a page from this scheme: it
  // would run on the trusted memry-file origin with read access to the
  // whole vault. Rendering goes through memry-html://, sandboxed; here the
  // bytes are only ever text (a download link still gets the file).
  const html = isHtmlEmbedPath(filePath)
  const headers: Record<string, string> = {
    'Content-Type': html
      ? 'text/plain; charset=utf-8'
      : mimeLookup(filePath) || 'application/octet-stream',
    'Accept-Ranges': 'bytes',
    ...(html ? { 'X-Content-Type-Options': 'nosniff' } : {})
  }

  // Range reads serve video/audio seeking and the PDF host's lazy loading.
  const match = rangeHeader?.match(/bytes=(\d*)-(\d*)/)
  if (match) {
    const start = match[1] ? parseInt(match[1], 10) : 0
    if (start >= fileSize) {
      await handle.close()
      return new Response(null, {
        status: 416,
        headers: { ...headers, 'Content-Range': `bytes */${fileSize}` }
      })
    }
    const end = Math.min(match[2] ? parseInt(match[2], 10) : fileSize - 1, fileSize - 1)
    const length = Math.max(end - start + 1, 0)
    let bytes = Buffer.alloc(length)
    try {
      const { bytesRead } = await handle.read(bytes, 0, length, start)
      bytes = bytes.subarray(0, bytesRead)
    } finally {
      await handle.close()
    }
    return new Response(bytes, {
      status: 206,
      headers: {
        ...headers,
        'Content-Length': String(bytes.length),
        'Content-Range': `bytes ${start}-${end}/${fileSize}`
      }
    })
  }

  const body = Readable.toWeb(handle.createReadStream()) as ReadableStream<Uint8Array>
  return new Response(body, {
    status: 200,
    headers: { ...headers, 'Content-Length': String(fileSize) }
  })
}

function serveFailed(error: unknown): Response {
  // A failure here renders as a silently broken image/PDF/video embed
  // (EACCES/EIO/file vanished mid-read — the class behind #896). Leave a
  // trace before answering 404; the path itself never leaves the process.
  mainLog.warn('memry-file: serve failed', { error })
  trackMainLog('warn', {
    scope: 'MemryFile',
    action: 'serve_failed',
    errorCode: toErrorCode(error)
  })
  return new Response(null, { status: 404, statusText: 'Not Found' })
}
