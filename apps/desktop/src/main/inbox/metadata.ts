/**
 * URL Metadata Extraction
 *
 * Uses metascraper to extract title, description, image, and other
 * metadata from URLs. Includes image downloading for offline thumbnails.
 *
 * @module main/inbox/metadata
 */

import { createLogger } from '../lib/logger'
import metascraper from 'metascraper'
import metascraperAuthor from 'metascraper-author'
import metascraperDate from 'metascraper-date'
import metascraperDescription from 'metascraper-description'
import metascraperImage from 'metascraper-image'
import metascraperLogo from 'metascraper-logo'
import metascraperPublisher from 'metascraper-publisher'
import metascraperTitle from 'metascraper-title'
import metascraperUrl from 'metascraper-url'
import { createWriteStream } from 'fs'
import { mkdir } from 'fs/promises'
import { pipeline } from 'stream/promises'
import { join, extname } from 'path'

const log = createLogger('Inbox:Metadata')

// ============================================================================
// Types
// ============================================================================

export interface UrlMetadata {
  title?: string
  description?: string
  image?: string
  author?: string
  publisher?: string
  date?: string
  logo?: string
  url?: string
}

// ============================================================================
// Constants
// ============================================================================

/** Timeout for fetching URL content (10 seconds) */
const URL_FETCH_TIMEOUT = 10000

/** Timeout for downloading images (5 seconds) */
const IMAGE_DOWNLOAD_TIMEOUT = 5000

/** Chrome User-Agent for better compatibility */
const USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'

/** Maximum image size to download (5MB) */
const MAX_IMAGE_SIZE = 5 * 1024 * 1024

// ============================================================================
// Metascraper Instance
// ============================================================================

const scraper = metascraper([
  metascraperAuthor(),
  metascraperDate(),
  metascraperDescription(),
  metascraperImage(),
  metascraperLogo(),
  metascraperPublisher(),
  metascraperTitle(),
  metascraperUrl()
])

// ============================================================================
// Site-Specific Helpers
// ============================================================================

function isRedditUrl(url: string): boolean {
  try {
    const host = new URL(url).hostname
    return host === 'www.reddit.com' || host === 'reddit.com' || host === 'old.reddit.com'
  } catch {
    return false
  }
}

function rewriteUrlForFetch(url: string): string {
  try {
    const parsed = new URL(url)
    if (parsed.hostname === 'www.reddit.com' || parsed.hostname === 'reddit.com') {
      parsed.hostname = 'old.reddit.com'
      return parsed.toString()
    }
  } catch {
    // invalid URL, return as-is
  }
  return url
}

async function fetchRedditMetadata(url: string): Promise<UrlMetadata | null> {
  const controller = new AbortController()
  const timeoutId = setTimeout(() => controller.abort(), URL_FETCH_TIMEOUT)

  try {
    const jsonUrl = url.replace(/\/?(\?.*)?$/, '.json$1')
    const response = await fetch(jsonUrl, {
      signal: controller.signal,
      headers: { 'User-Agent': USER_AGENT }
    })

    if (!response.ok) return null

    const data = await response.json()
    const post = data?.[0]?.data?.children?.[0]?.data
    if (!post) return null

    const previewUrl = post.preview?.images?.[0]?.source?.url?.replace(/&amp;/g, '&')
    const thumbnail =
      post.thumbnail && post.thumbnail !== 'self' && post.thumbnail !== 'default'
        ? post.thumbnail
        : undefined

    return {
      title: post.title || undefined,
      description: post.selftext ? post.selftext.slice(0, 300) : undefined,
      image: previewUrl || thumbnail,
      author: post.author ? `u/${post.author}` : undefined,
      publisher: post.subreddit_name_prefixed || 'Reddit',
      date: post.created_utc ? new Date(post.created_utc * 1000).toISOString() : undefined,
      logo: 'https://www.redditstatic.com/desktop2x/img/favicon/favicon-32x32.png',
      url
    }
  } catch (error) {
    log.warn('Reddit JSON API failed, falling back to HTML:', error)
    return null
  } finally {
    clearTimeout(timeoutId)
  }
}

// ============================================================================
// URL Metadata Extraction
// ============================================================================

export async function fetchUrlMetadata(url: string): Promise<UrlMetadata> {
  if (isRedditUrl(url)) {
    const reddit = await fetchRedditMetadata(url)
    if (reddit) return reddit
  }

  const fetchUrl = rewriteUrlForFetch(url)
  const controller = new AbortController()
  const timeoutId = setTimeout(() => controller.abort(), URL_FETCH_TIMEOUT)

  try {
    const response = await fetch(fetchUrl, {
      signal: controller.signal,
      headers: {
        'User-Agent': USER_AGENT,
        Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.5'
      }
    })

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${response.statusText}`)
    }

    const html = await response.text()
    const metadata = await scraper({ html, url })

    if (metadata.title && isBotPageTitle(metadata.title)) {
      log.warn(`Bot page detected for ${url}: "${metadata.title}"`)
      return { url, title: undefined }
    }

    return {
      title: metadata.title || undefined,
      description: metadata.description || undefined,
      image: metadata.image || undefined,
      author: metadata.author || undefined,
      publisher: metadata.publisher || undefined,
      date: metadata.date || undefined,
      logo: metadata.logo || undefined,
      url: metadata.url || url
    }
  } finally {
    clearTimeout(timeoutId)
  }
}

// ============================================================================
// Image Downloading
// ============================================================================

/**
 * Get file extension from URL or content-type
 */
function getImageExtension(imageUrl: string, contentType?: string | null): string {
  // Try to get extension from content-type header
  if (contentType) {
    const typeMap: Record<string, string> = {
      'image/jpeg': '.jpg',
      'image/jpg': '.jpg',
      'image/png': '.png',
      'image/gif': '.gif',
      'image/webp': '.webp',
      'image/svg+xml': '.svg'
    }
    const ext = typeMap[contentType.split(';')[0].trim()]
    if (ext) return ext
  }

  // Try to get extension from URL
  try {
    const urlPath = new URL(imageUrl).pathname
    const ext = extname(urlPath).toLowerCase()
    if (['.jpg', '.jpeg', '.png', '.gif', '.webp', '.svg'].includes(ext)) {
      return ext === '.jpeg' ? '.jpg' : ext
    }
  } catch {
    // Invalid URL, use default
  }

  return '.jpg' // Default to jpg
}

/**
 * Download an image to a local directory
 *
 * @param imageUrl - The URL of the image to download
 * @param destDir - The destination directory to save the image
 * @returns Relative path to the downloaded image, or null if download fails
 */
export async function downloadImage(imageUrl: string, destDir: string): Promise<string | null> {
  const controller = new AbortController()
  const timeoutId = setTimeout(() => controller.abort(), IMAGE_DOWNLOAD_TIMEOUT)

  try {
    const response = await fetch(imageUrl, {
      signal: controller.signal,
      headers: {
        'User-Agent': USER_AGENT,
        Accept: 'image/*'
      }
    })

    if (!response.ok) {
      log.warn(`Image download failed: HTTP ${response.status}`)
      return null
    }

    // Check content length
    const contentLength = response.headers.get('content-length')
    if (contentLength && parseInt(contentLength, 10) > MAX_IMAGE_SIZE) {
      log.warn(`Image too large: ${contentLength} bytes`)
      return null
    }

    // Ensure directory exists
    await mkdir(destDir, { recursive: true })

    // Determine filename
    const contentType = response.headers.get('content-type')
    const ext = getImageExtension(imageUrl, contentType)
    const filename = `thumbnail${ext}`
    const filePath = join(destDir, filename)

    // Stream response body to file
    if (!response.body) {
      log.warn('No response body for image')
      return null
    }

    // Convert web stream to node stream and pipe to file
    const nodeStream = await import('stream')
    const { Readable } = nodeStream
    const readable = Readable.fromWeb(response.body as import('stream/web').ReadableStream)
    const writeStream = createWriteStream(filePath)

    await pipeline(readable, writeStream)

    return filename
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') {
      log.warn('Image download timed out')
    } else {
      log.warn('Image download error:', error)
    }
    return null
  } finally {
    clearTimeout(timeoutId)
  }
}

// ============================================================================
// Utility Functions
// ============================================================================

/**
 * Check if a string is a valid URL
 */
export function isValidUrl(str: string): boolean {
  try {
    const url = new URL(str)
    return url.protocol === 'http:' || url.protocol === 'https:'
  } catch {
    return false
  }
}

import { extractDomain as extractDomainNullable } from '../lib/url-utils'

export function extractDomain(url: string): string {
  return extractDomainNullable(url) ?? url
}

const BOT_PAGE_TITLES = [
  'just a moment...',
  'attention required!',
  'access denied',
  'please wait',
  'verify you are human',
  'checking your browser'
]

export function isBotPageTitle(title: string): boolean {
  if (!title) return false
  const lower = title.toLowerCase()
  return BOT_PAGE_TITLES.some((bot) => lower.includes(bot))
}

export function titleFromUrl(url: string): string {
  try {
    const parsed = new URL(url)
    const segments = parsed.pathname.split('/').filter(Boolean)

    if (segments.length === 0) {
      return parsed.hostname.replace(/^www\./, '')
    }

    const last = segments[segments.length - 1]

    const cleaned = last
      .replace(/\.[a-z]+$/, '')
      .replace(/--\d+$/, '')
      .replace(/-\d+$/, '')
      .replace(/[-_]+/g, ' ')
      .trim()

    if (!cleaned) {
      return parsed.hostname.replace(/^www\./, '')
    }

    return cleaned.replace(/\b\w/g, (c) => c.toUpperCase())
  } catch {
    return url
  }
}
