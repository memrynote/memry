export const MEMRY_NATIVE_HOST = 'com.memry.capture'
const MAX_HTML_LENGTH = 100000
const MAX_TEXT_LENGTH = 50000
const MAX_URL_LENGTH = 2000
const MAX_TITLE_LENGTH = 200

const FILE_EXTENSIONS = new Set([
  'png',
  'jpg',
  'jpeg',
  'gif',
  'webp',
  'svg',
  'pdf',
  'mp3',
  'wav',
  'ogg',
  'm4a',
  'flac',
  'aac',
  'webm',
  'mp4',
  'mov',
  'avi',
  'mkv'
])

const MIME_BY_EXTENSION = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  svg: 'image/svg+xml',
  pdf: 'application/pdf',
  mp3: 'audio/mpeg',
  wav: 'audio/wav',
  ogg: 'audio/ogg',
  m4a: 'audio/x-m4a',
  flac: 'audio/flac',
  aac: 'audio/aac',
  webm: 'video/webm',
  mp4: 'video/mp4',
  mov: 'video/quicktime',
  avi: 'video/x-msvideo',
  mkv: 'video/x-matroska'
}

function definedFields(fields) {
  return Object.fromEntries(Object.entries(fields).filter(([, value]) => value !== undefined))
}

function truncate(value, maxLength) {
  if (typeof value !== 'string') return value
  return value.length > maxLength ? value.slice(0, maxLength) : value
}

function extensionFromUrl(url) {
  try {
    const pathname = new URL(url).pathname
    const name = pathname.split('/').filter(Boolean).pop() || ''
    const extension = name.includes('.') ? name.split('.').pop().toLowerCase() : ''
    return FILE_EXTENSIONS.has(extension) ? extension : ''
  } catch {
    return ''
  }
}

export function filenameFromUrl(url, fallback = 'capture.bin') {
  try {
    const pathname = new URL(url).pathname
    const filename = decodeURIComponent(pathname.split('/').filter(Boolean).pop() || '')
    return filename || fallback
  } catch {
    return fallback
  }
}

export function isProbablyFileUrl(url) {
  return extensionFromUrl(url) !== ''
}

export function mimeTypeFromUrl(url, fallback = 'application/octet-stream') {
  const extension = extensionFromUrl(url)
  return extension ? MIME_BY_EXTENSION[extension] : fallback
}

export function createEnvelope(capture, now = new Date()) {
  return {
    schemaVersion: 1,
    capturedAt: now.toISOString(),
    source: 'chrome-extension',
    capture
  }
}

export function createLinkCapture({ url, sourceTitle, tags }) {
  return definedFields({
    kind: 'link',
    url: truncate(url, MAX_URL_LENGTH),
    sourceTitle: truncate(sourceTitle, MAX_TITLE_LENGTH),
    tags
  })
}

export function createClipCapture({ text, html, sourceUrl, sourceTitle, tags }) {
  return definedFields({
    kind: 'clip',
    text: truncate(text, MAX_TEXT_LENGTH),
    html: truncate(html, MAX_HTML_LENGTH),
    sourceUrl: truncate(sourceUrl, MAX_URL_LENGTH),
    sourceTitle: truncate(sourceTitle, MAX_TITLE_LENGTH),
    tags
  })
}

export function createPageCapture({ text, html, sourceUrl, sourceTitle, tags }) {
  return definedFields({
    kind: 'page',
    text: truncate(text, MAX_TEXT_LENGTH),
    html: truncate(html, MAX_HTML_LENGTH),
    sourceUrl: truncate(sourceUrl, MAX_URL_LENGTH),
    sourceTitle: truncate(sourceTitle, MAX_TITLE_LENGTH),
    tags
  })
}

export function createFileCapture({
  dataBase64,
  filename,
  mimeType,
  sourceUrl,
  sourceTitle,
  tags
}) {
  return definedFields({
    kind: 'file',
    dataBase64,
    filename,
    mimeType,
    sourceUrl: truncate(sourceUrl, MAX_URL_LENGTH),
    sourceTitle: truncate(sourceTitle, MAX_TITLE_LENGTH),
    tags
  })
}

export function arrayBufferToBase64(buffer) {
  if (typeof Buffer !== 'undefined') {
    return Buffer.from(buffer).toString('base64')
  }

  let binary = ''
  const bytes = new Uint8Array(buffer)
  for (let index = 0; index < bytes.byteLength; index += 1) {
    binary += String.fromCharCode(bytes[index])
  }
  return btoa(binary)
}

export async function responseToFileCapture(response, { sourceUrl, sourceTitle }) {
  const dataBase64 = arrayBufferToBase64(await response.arrayBuffer())
  const contentType = response.headers.get('content-type')?.split(';')[0].trim()
  const fallbackMimeType = mimeTypeFromUrl(sourceUrl)
  const mimeType =
    !contentType || contentType === 'application/octet-stream' ? fallbackMimeType : contentType

  return createFileCapture({
    dataBase64,
    filename: filenameFromUrl(sourceUrl),
    mimeType,
    sourceUrl,
    sourceTitle
  })
}
