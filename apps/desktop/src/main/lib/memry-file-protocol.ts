import { createReadStream, existsSync, statSync } from 'node:fs'
import { normalize, resolve } from 'node:path'
import { net } from 'electron'
import { lookup as mimeLookup } from 'mime-types'
import { toErrorCode } from '@memry/contracts/telemetry-api'
import { trackMainLog } from '../telemetry/diagnostics'
import { healAttachmentPath } from '../vault/attachment-heal'
import { isHtmlEmbedPath } from '../vault/html-embed-protocol'
import { remapCrossDeviceAttachmentPath } from './attachment-path-remap'
import { isPathInsideDirs } from './external-url'
import { createLogger } from './logger'

const mainLog = createLogger('Main')

/** The `memry-file://` protocol: serves vault and userData files to the renderer. */
export async function serveMemryFile(
  request: Request,
  userDataPath: string,
  rawVaultPaths: ReadonlyArray<string | null | undefined>
): Promise<Response> {
  // URL format: memry-file://local/absolute/path/to/file
  // Using 'local' as explicit host to avoid URL parsing issues
  const url = new URL(request.url)
  // The pathname is URL-encoded, need to decode it
  let filePath = decodeURIComponent(url.pathname)

  // On macOS/Linux, the path should be absolute (starts with /)
  if (process.platform !== 'win32') {
    // Ensure the path starts with /
    if (!filePath.startsWith('/')) {
      filePath = '/' + filePath
    }
  } else {
    // On Windows, remove the leading slash from /C:/path/to/file
    if (filePath.startsWith('/')) {
      filePath = filePath.slice(1)
    }
  }

  filePath = resolve(normalize(filePath))

  const allowedDirs: string[] = [userDataPath]
  const vaultPaths = rawVaultPaths.filter((vaultPath): vaultPath is string => Boolean(vaultPath))
  for (const vaultPath of vaultPaths) {
    const resolvedVaultPath = resolve(vaultPath)
    if (!allowedDirs.includes(resolvedVaultPath)) allowedDirs.push(resolvedVaultPath)
  }

  let isAllowed = isPathInsideDirs(filePath, allowedDirs)
  if (!isAllowed) {
    // Note blocks store the ORIGIN machine's absolute path (memry-file://local/<abs>),
    // so a note synced from another device points at a path that doesn't exist
    // here. The bytes live at the same attachments/<noteId>/<file> spot inside
    // this device's vault — serve from there when present.
    const remapped = remapCrossDeviceAttachmentPath(filePath, vaultPaths)
    if (remapped) {
      mainLog.debug('memry-file: remapped cross-device attachment path', {
        requested: filePath,
        remapped
      })
      filePath = remapped
      isAllowed = true
    }
  }
  if (!isAllowed) {
    mainLog.warn('memry-file: blocked path outside allowed directories', { filePath })
    return new Response(null, { status: 403, statusText: 'Forbidden' })
  }

  if (!existsSync(filePath)) {
    // Self-heal (#1713): an attachment renamed on disk outside the app is
    // served from its unique prefix/suffix match in the same note's folder.
    // The note is never rewritten — each device heals against its own disk
    // (see vault/attachment-heal.ts). Runs before the transparent-PNG
    // fallback so renamed images heal instead of rendering as 1x1 blanks.
    const healed = healAttachmentPath(filePath, vaultPaths)
    if (healed) {
      mainLog.debug('memry-file: healed renamed attachment', {
        requested: filePath,
        healed
      })
      filePath = healed
    } else if (
      // Return empty 1x1 transparent PNG for missing image files (null
      // thumbnails). This avoids console errors and broken image icons
      filePath.endsWith('.png') ||
      filePath.endsWith('.jpg') ||
      filePath.endsWith('.jpeg') ||
      filePath.endsWith('.gif') ||
      filePath.endsWith('.webp')
    ) {
      // 1x1 transparent PNG
      const transparentPng = Buffer.from(
        'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=',
        'base64'
      )
      return new Response(transparentPng, {
        status: 200,
        headers: { 'Content-Type': 'image/png' }
      })
    } else {
      // Return 404 for other missing files
      return new Response(null, { status: 404, statusText: 'Not Found' })
    }
  }

  try {
    const stats = statSync(filePath)
    const fileSize = stats.size
    const mimeType = mimeLookup(filePath) || 'application/octet-stream'

    // Never let an attached HTML file render as a page from this scheme: it
    // would run on the trusted memry-file origin with read access to the
    // whole vault. Rendering goes through memry-html://, sandboxed; here the
    // bytes are only ever text (a download link still gets the file).
    // Read through the same file:// fetch as the full-file path below rather
    // than re-opening the checked path (CodeQL js/file-system-race).
    if (isHtmlEmbedPath(filePath)) {
      const file = await net.fetch(`file://${filePath}`)
      return new Response(file.body, {
        status: file.status,
        headers: {
          'Content-Type': 'text/plain; charset=utf-8',
          'X-Content-Type-Options': 'nosniff'
        }
      })
    }

    // Check for Range header (needed for video/audio seeking)
    const rangeHeader = request.headers.get('Range')

    if (rangeHeader) {
      // Parse Range header (e.g., "bytes=0-1023")
      const match = rangeHeader.match(/bytes=(\d*)-(\d*)/)
      if (match) {
        const start = match[1] ? parseInt(match[1], 10) : 0
        const end = match[2] ? parseInt(match[2], 10) : fileSize - 1
        const chunkSize = end - start + 1

        // Create readable stream for the range
        const stream = createReadStream(filePath, { start, end })
        const chunks: Buffer[] = []

        for await (const chunk of stream) {
          chunks.push(Buffer.from(chunk))
        }

        const buffer = Buffer.concat(chunks)

        return new Response(buffer, {
          status: 206,
          headers: {
            'Content-Type': mimeType,
            'Content-Length': String(chunkSize),
            'Content-Range': `bytes ${start}-${end}/${fileSize}`,
            'Accept-Ranges': 'bytes'
          }
        })
      }
    }

    // No Range header - return full file
    return net.fetch(`file://${filePath}`)
  } catch (error) {
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
}
