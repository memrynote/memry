/**
 * Unsplash cover source.
 *
 * The picker hotlinks the thumbnails Unsplash returns, as the API licence
 * requires, but a chosen cover is copied into the note's own attachments folder
 * so it keeps working offline and on every other device. Nothing here ever
 * leaves a hotlinked URL in a note.
 */

import {
  UnsplashPhotoSchema,
  type UnsplashDownloadInput,
  type UnsplashDownloadResult,
  type UnsplashPhoto,
  type UnsplashSearchInput,
  type UnsplashSearchResult
} from '@memry/contracts/unsplash-api'

import { createLogger } from '../lib/logger'
import { saveAttachment } from '../vault/attachments'
import { emitNoteAttachmentSaved } from '../notes/runtime-effects'

const logger = createLogger('Unsplash')

const SEARCH_ENDPOINT = 'https://api.unsplash.com/search/photos'
const PER_PAGE = 30

/** Enough to make paging back and forth free without holding a session's worth of results. */
const CACHE_LIMIT = 50

const EXTENSION_BY_MIME: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'image/gif': 'gif'
}

/**
 * The slice of `fetch` this module uses, declared structurally so the service
 * never imports `electron` and stays runnable under plain Node in tests. The
 * handler passes `net.fetch`.
 */
export interface UnsplashResponse {
  ok: boolean
  status: number
  headers: { get(name: string): string | null }
  json(): Promise<unknown>
  text(): Promise<string>
  arrayBuffer(): Promise<ArrayBuffer>
}

export type UnsplashFetch = (
  url: string,
  init?: { headers?: Record<string, string> }
) => Promise<UnsplashResponse>

export interface UnsplashDeps {
  fetch: UnsplashFetch
}

const searchCache = new Map<string, UnsplashSearchResult>()

export function resetUnsplashCacheForTests(): void {
  searchCache.clear()
}

/**
 * The developer-supplied access key, read per call so a key set after startup
 * still takes effect. There is no settings UI: the key belongs to the build.
 */
function getAccessKey(): string | null {
  const key = process.env.MEMRY_UNSPLASH_ACCESS_KEY?.trim()
  return key ? key : null
}

export function isAvailable(): boolean {
  return getAccessKey() !== null
}

function authHeaders(accessKey: string): Record<string, string> {
  return {
    Authorization: `Client-ID ${accessKey}`,
    'Accept-Version': 'v1'
  }
}

function readRateLimitRemaining(response: UnsplashResponse): number | null {
  const raw = response.headers.get('X-Ratelimit-Remaining')
  if (raw === null) return null
  const parsed = Number(raw)
  return Number.isFinite(parsed) ? parsed : null
}

async function isRateLimited(response: UnsplashResponse): Promise<boolean> {
  if (response.status === 429) return true
  if (response.status !== 403) return false
  if (readRateLimitRemaining(response) === 0) return true
  try {
    return /rate limit/i.test(await response.text())
  } catch {
    return false
  }
}

/**
 * Shape a raw API photo into the contract's shape, then run it through the
 * contract's own schema. Anything that fails the host or field checks is
 * dropped rather than surfaced, so a single odd record cannot poison a page of
 * results or smuggle a non-Unsplash URL back in on download.
 */
function toPhoto(raw: unknown): UnsplashPhoto | null {
  if (typeof raw !== 'object' || raw === null) return null
  const record = raw as Record<string, unknown>
  const urls = (record.urls ?? {}) as Record<string, unknown>
  const links = (record.links ?? {}) as Record<string, unknown>
  const user = (record.user ?? {}) as Record<string, unknown>

  const parsed = UnsplashPhotoSchema.safeParse({
    id: record.id,
    thumbUrl: urls.thumb,
    previewUrl: urls.small,
    fullUrl: urls.regular,
    downloadLocation: links.download_location,
    authorName: user.name,
    htmlUrl: links.html,
    blurHash: typeof record.blur_hash === 'string' ? record.blur_hash : null,
    width: record.width,
    height: record.height
  })
  return parsed.success ? parsed.data : null
}

function cacheSearch(key: string, result: UnsplashSearchResult): void {
  if (searchCache.size >= CACHE_LIMIT) {
    const oldest = searchCache.keys().next()
    if (!oldest.done) searchCache.delete(oldest.value)
  }
  searchCache.set(key, result)
}

export async function searchPhotos(
  input: UnsplashSearchInput,
  deps: UnsplashDeps
): Promise<UnsplashSearchResult> {
  const accessKey = getAccessKey()
  if (!accessKey) return { ok: false, reason: 'not-configured' }

  const query = input.query.trim()
  if (!query) return { ok: true, photos: [], rateLimitRemaining: null }

  const page = input.page ?? 1
  const cacheKey = `${query}:${page}`
  const cached = searchCache.get(cacheKey)
  if (cached) return cached

  const url = `${SEARCH_ENDPOINT}?query=${encodeURIComponent(query)}&page=${page}&per_page=${PER_PAGE}&content_filter=high`

  let response: UnsplashResponse
  try {
    response = await deps.fetch(url, { headers: authHeaders(accessKey) })
  } catch (error) {
    logger.warn('Unsplash search could not reach the network', { error })
    return { ok: false, reason: 'offline' }
  }

  if (!response.ok) {
    if (await isRateLimited(response)) return { ok: false, reason: 'rate-limited' }
    logger.error('Unsplash search failed', { status: response.status })
    return { ok: false, reason: 'failed' }
  }

  let body: unknown
  try {
    body = await response.json()
  } catch (error) {
    logger.error('Unsplash search returned a body we could not read', { error })
    return { ok: false, reason: 'failed' }
  }

  const results = (body as { results?: unknown })?.results
  if (!Array.isArray(results)) {
    logger.error('Unsplash search returned no results array')
    return { ok: false, reason: 'failed' }
  }

  const photos = results.map(toPhoto).filter((photo): photo is UnsplashPhoto => photo !== null)
  const result: UnsplashSearchResult = {
    ok: true,
    photos,
    rateLimitRemaining: readRateLimitRemaining(response)
  }
  cacheSearch(cacheKey, result)
  return result
}

/**
 * The licence requires a GET to `download_location` once per pick. It is a
 * tracking event, not a prerequisite for the bytes, so a failure here is logged
 * and never blocks the user's cover — the image itself comes from a CDN that
 * does not share the API's rate limit.
 */
async function pingDownloadLocation(photo: UnsplashPhoto, accessKey: string, fetch: UnsplashFetch) {
  try {
    const response = await fetch(photo.downloadLocation, { headers: authHeaders(accessKey) })
    if (!response.ok) {
      logger.warn('Unsplash download tracking ping was rejected', { status: response.status })
    }
  } catch (error) {
    logger.warn('Unsplash download tracking ping could not be sent', { error })
  }
}

function extensionFor(response: UnsplashResponse): string {
  const contentType = response.headers.get('Content-Type')?.split(';')[0]?.trim().toLowerCase()
  return (contentType && EXTENSION_BY_MIME[contentType]) || 'jpg'
}

export async function downloadPhoto(
  input: UnsplashDownloadInput,
  deps: UnsplashDeps
): Promise<UnsplashDownloadResult> {
  const accessKey = getAccessKey()
  if (!accessKey) return { ok: false, reason: 'not-configured' }

  const { noteId, photo } = input

  await pingDownloadLocation(photo, accessKey, deps.fetch)

  let response: UnsplashResponse
  try {
    response = await deps.fetch(photo.fullUrl)
  } catch (error) {
    logger.warn('Unsplash photo could not be fetched', { error })
    return { ok: false, reason: 'offline' }
  }

  if (!response.ok) {
    if (await isRateLimited(response)) return { ok: false, reason: 'rate-limited' }
    logger.error('Unsplash photo fetch failed', { status: response.status })
    return { ok: false, reason: 'failed' }
  }

  let bytes: Buffer
  try {
    bytes = Buffer.from(new Uint8Array(await response.arrayBuffer()))
  } catch (error) {
    logger.error('Unsplash photo body could not be read', { error })
    return { ok: false, reason: 'failed' }
  }

  const saved = await saveAttachment(
    noteId,
    bytes,
    `unsplash-${photo.id}.${extensionFor(response)}`
  )
  if (!saved.success || !saved.path) {
    logger.error('Unsplash cover could not be written to the vault', { noteId, error: saved.error })
    return { ok: false, reason: 'write-failed' }
  }

  // `saveAttachment` falls back to an absolute `memry-file://` URL when the
  // note is not indexed yet. That ref names this machine's vault path, and the
  // cover is stored in frontmatter that syncs, so accepting it would hand every
  // other device a broken cover. Refuse instead of writing a ref that only
  // works here.
  if (/^[a-zA-Z][a-zA-Z\d+\-.]*:/.test(saved.path) || saved.path.startsWith('/')) {
    logger.error('Unsplash cover resolved to a non-portable ref', { noteId })
    return { ok: false, reason: 'write-failed' }
  }

  if (saved.diskPath) {
    try {
      emitNoteAttachmentSaved(noteId, saved.diskPath)
    } catch (error) {
      logger.warn('Cover attachment sync emit failed after local save', { noteId, error })
    }
  }

  return {
    ok: true,
    ref: saved.path,
    credit: { name: photo.authorName, url: photo.htmlUrl }
  }
}
