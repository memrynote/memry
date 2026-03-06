/* eslint-disable @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-call */
// External social media APIs return dynamic JSON structures - type safety not feasible without extensive runtime validation

/**
 * Social Media Post Extraction
 *
 * Handles extraction of metadata from social media posts (Twitter/X, LinkedIn,
 * Mastodon, Bluesky, Threads). Uses oEmbed when available, falls back to
 * metascraper for basic metadata extraction.
 *
 * @module main/inbox/social
 */

import { createLogger } from '../lib/logger'
import type { SocialMetadata } from '@memry/contracts/inbox-api'
import {
  detectSocialPlatform,
  isSocialPost,
  extractDomain,
  type SocialPlatform
} from '../lib/url-utils'

const log = createLogger('Inbox:Social')

// ============================================================================
// Types
// ============================================================================

export interface SocialExtractionResult {
  success: boolean
  metadata: SocialMetadata | null
  error?: string
}

interface OEmbedResponse {
  type: string
  version: string
  title?: string
  author_name?: string
  author_url?: string
  provider_name?: string
  provider_url?: string
  html?: string
  width?: number
  height?: number
  url?: string
}

interface TwitterOEmbedResponse extends OEmbedResponse {
  author_name: string
  author_url: string
  html: string
}

// ============================================================================
// Constants
// ============================================================================

/** oEmbed endpoints for supported platforms */
const OEMBED_ENDPOINTS: Record<SocialPlatform, string | null> = {
  twitter: 'https://publish.twitter.com/oembed',
  linkedin: null, // LinkedIn oEmbed requires authentication
  mastodon: null, // Mastodon uses instance-specific oEmbed
  bluesky: null, // Bluesky doesn't have oEmbed yet
  threads: null // Threads doesn't have public oEmbed
}

/** Request timeout in milliseconds */
const FETCH_TIMEOUT = 10000

// ============================================================================
// Utility Functions
// ============================================================================

/**
 * Fetch with timeout support
 */
async function fetchWithTimeout(
  url: string,
  options: RequestInit = {},
  timeout = FETCH_TIMEOUT
): Promise<Response> {
  const controller = new AbortController()
  const timeoutId = setTimeout(() => controller.abort(), timeout)

  try {
    const response = await fetch(url, {
      ...options,
      signal: controller.signal
    })
    return response
  } finally {
    clearTimeout(timeoutId)
  }
}

/**
 * Parse Twitter oEmbed HTML to extract post content
 *
 * Twitter oEmbed returns HTML like:
 * <blockquote class="twitter-tweet"><p lang="en" dir="ltr">Tweet content...</p>
 * &mdash; Author Name (@handle) <a href="...">Date</a></blockquote>
 */
function parseTwitterEmbedHtml(html: string): {
  content: string
  authorName: string
  authorHandle: string
  timestamp?: string
} {
  // Extract content from <p> tag
  const contentMatch = html.match(/<p[^>]*>([\s\S]*?)<\/p>/)
  let content = contentMatch ? contentMatch[1] : ''

  // Clean up HTML entities and tags
  content = content
    .replace(/<a[^>]*>(.*?)<\/a>/g, '$1') // Keep link text, remove tag
    .replace(/<br\s*\/?>/g, '\n') // Convert br to newlines
    .replace(/&mdash;/g, '—')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/<[^>]+>/g, '') // Remove remaining HTML tags
    .trim()

  // Extract author info from "— Author Name (@handle)"
  const authorMatch = html.match(/&mdash;\s*([^(]+)\s*\(@([^)]+)\)/)
  const authorName = authorMatch ? authorMatch[1].trim() : ''
  const authorHandle = authorMatch ? authorMatch[2].trim() : ''

  // Extract timestamp from the date link
  const timestampMatch = html.match(/<a href="[^"]*">([A-Za-z]+ \d+, \d+)<\/a>\s*<\/blockquote>/)
  const timestamp = timestampMatch ? timestampMatch[1] : undefined

  return { content, authorName, authorHandle, timestamp }
}

/**
 * Extract handle from Twitter/X author URL
 * e.g., "https://twitter.com/username" -> "username"
 */
function extractHandleFromUrl(authorUrl: string): string {
  try {
    const url = new URL(authorUrl)
    const pathParts = url.pathname.split('/').filter(Boolean)
    return pathParts[0] || ''
  } catch {
    return ''
  }
}

// ============================================================================
// Platform-Specific Extractors
// ============================================================================

/**
 * Extract metadata from Twitter/X posts using oEmbed API
 *
 * Twitter oEmbed API: https://developer.twitter.com/en/docs/twitter-for-websites/oembed-api
 */
async function extractTwitterPost(url: string): Promise<SocialExtractionResult> {
  const endpoint = OEMBED_ENDPOINTS.twitter
  if (!endpoint) {
    return {
      success: false,
      metadata: null,
      error: 'Twitter oEmbed endpoint not configured'
    }
  }

  try {
    const oembedUrl = `${endpoint}?url=${encodeURIComponent(url)}&omit_script=true&dnt=true`
    log.debug(`Fetching Twitter oEmbed: ${oembedUrl}`)

    const response = await fetchWithTimeout(oembedUrl, {
      headers: {
        Accept: 'application/json',
        'User-Agent': 'Memry/1.0'
      }
    })

    if (!response.ok) {
      // Twitter returns 404 for protected/deleted tweets
      if (response.status === 404) {
        return {
          success: false,
          metadata: null,
          error: 'Tweet not found or protected'
        }
      }
      return {
        success: false,
        metadata: null,
        error: `Twitter oEmbed returned ${response.status}`
      }
    }

    const data = (await response.json()) as TwitterOEmbedResponse

    // Parse the HTML embed to extract content
    const parsed = parseTwitterEmbedHtml(data.html || '')

    // Build author handle - prefer parsed, fallback to URL extraction
    const authorHandle = parsed.authorHandle || extractHandleFromUrl(data.author_url || '')

    const metadata: SocialMetadata = {
      platform: 'twitter',
      postUrl: url,
      authorName: data.author_name || parsed.authorName || 'Unknown',
      authorHandle: authorHandle ? `@${authorHandle}` : '',
      authorAvatar: undefined, // Twitter oEmbed doesn't include avatar
      postContent: parsed.content || data.title || '',
      timestamp: parsed.timestamp,
      mediaUrls: [], // oEmbed doesn't include media URLs directly
      extractionStatus: parsed.content ? 'full' : 'partial'
    }

    log.info(
      `Twitter extraction successful: @${authorHandle}, content length: ${metadata.postContent.length}`
    )

    return { success: true, metadata }
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error'
    log.error('Twitter extraction failed:', message)
    return {
      success: false,
      metadata: null,
      error: `Twitter extraction failed: ${message}`
    }
  }
}

/**
 * Extract metadata from Mastodon posts
 *
 * Mastodon instances have their own oEmbed endpoints at /api/oembed
 */
async function extractMastodonPost(url: string): Promise<SocialExtractionResult> {
  try {
    const domain = extractDomain(url)
    if (!domain) {
      return { success: false, metadata: null, error: 'Invalid Mastodon URL' }
    }

    // Mastodon oEmbed endpoint
    const oembedUrl = `https://${domain}/api/oembed?url=${encodeURIComponent(url)}`
    log.debug(`Fetching Mastodon oEmbed: ${oembedUrl}`)

    const response = await fetchWithTimeout(oembedUrl, {
      headers: {
        Accept: 'application/json',
        'User-Agent': 'Memry/1.0'
      }
    })

    if (!response.ok) {
      return {
        success: false,
        metadata: null,
        error: `Mastodon oEmbed returned ${response.status}`
      }
    }

    const data = (await response.json()) as OEmbedResponse

    // Parse author info from author_name (format varies by instance)
    // Common format: "Username (@handle@instance.social)"
    let authorName = data.author_name || ''
    let authorHandle = ''

    const handleMatch = authorName.match(/\(@([^)]+)\)/)
    if (handleMatch) {
      authorHandle = `@${handleMatch[1]}`
      authorName = authorName.replace(/\s*\(@[^)]+\)/, '').trim()
    }

    // Extract content from HTML if available
    let postContent = data.title || ''
    if (data.html) {
      // Simple HTML stripping for Mastodon embeds
      postContent = data.html
        .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
        .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
        .replace(/<[^>]+>/g, ' ')
        .replace(/\s+/g, ' ')
        .trim()
        .substring(0, 500) // Limit length
    }

    const metadata: SocialMetadata = {
      platform: 'mastodon',
      postUrl: url,
      authorName: authorName || 'Unknown',
      authorHandle,
      postContent,
      mediaUrls: [],
      extractionStatus: postContent ? 'full' : 'partial'
    }

    log.info(`Mastodon extraction successful: ${authorHandle}`)

    return { success: true, metadata }
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error'
    log.error('Mastodon extraction failed:', message)
    return {
      success: false,
      metadata: null,
      error: `Mastodon extraction failed: ${message}`
    }
  }
}

/**
 * Extract metadata from Bluesky posts
 *
 * Bluesky uses AT Protocol. We can try to fetch post data via their public API.
 * URL format: https://bsky.app/profile/{handle}/post/{postId}
 */
async function extractBlueskyPost(url: string): Promise<SocialExtractionResult> {
  try {
    // Parse Bluesky URL to extract handle and post ID
    const urlObj = new URL(url)
    const pathParts = urlObj.pathname.split('/').filter(Boolean)

    // Expected format: /profile/{handle}/post/{postId}
    if (pathParts.length < 4 || pathParts[0] !== 'profile' || pathParts[2] !== 'post') {
      return { success: false, metadata: null, error: 'Invalid Bluesky post URL format' }
    }

    const handle = pathParts[1]
    const postId = pathParts[3]

    // Bluesky public API endpoint
    const apiUrl = `https://public.api.bsky.app/xrpc/app.bsky.feed.getPostThread?uri=at://${handle}/app.bsky.feed.post/${postId}&depth=0`
    log.debug(`Fetching Bluesky post: ${apiUrl}`)

    const response = await fetchWithTimeout(apiUrl, {
      headers: {
        Accept: 'application/json',
        'User-Agent': 'Memry/1.0'
      }
    })

    if (!response.ok) {
      // Try alternative: resolve handle first
      if (response.status === 400) {
        // Handle might need DID resolution - fall back to partial extraction
        return {
          success: true,
          metadata: {
            platform: 'bluesky',
            postUrl: url,
            authorName: handle,
            authorHandle: `@${handle}`,
            postContent: '', // Can't get content without API
            mediaUrls: [],
            extractionStatus: 'partial'
          }
        }
      }
      return {
        success: false,
        metadata: null,
        error: `Bluesky API returned ${response.status}`
      }
    }

    const data = await response.json()
    const post = data.thread?.post

    if (!post) {
      return { success: false, metadata: null, error: 'Post not found in response' }
    }

    const author = post.author || {}
    const record = post.record || {}

    const metadata: SocialMetadata = {
      platform: 'bluesky',
      postUrl: url,
      authorName: author.displayName || author.handle || handle,
      authorHandle: `@${author.handle || handle}`,
      authorAvatar: author.avatar,
      postContent: record.text || '',
      timestamp: record.createdAt,
      mediaUrls: (post.embed?.images || []).map((img: { fullsize: string }) => img.fullsize),
      metrics: {
        likes: post.likeCount,
        reposts: post.repostCount,
        replies: post.replyCount
      },
      extractionStatus: 'full'
    }

    log.info(`Bluesky extraction successful: @${author.handle}`)

    return { success: true, metadata }
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error'
    log.error('Bluesky extraction failed:', message)
    return {
      success: false,
      metadata: null,
      error: `Bluesky extraction failed: ${message}`
    }
  }
}

/**
 * Extract metadata from LinkedIn posts
 *
 * LinkedIn has very limited public access. We extract what we can from the URL
 * and basic page metadata.
 */
function extractLinkedInPost(url: string): SocialExtractionResult {
  // LinkedIn doesn't have a public oEmbed API that works without authentication
  // Return partial metadata with the URL
  return {
    success: true,
    metadata: {
      platform: 'linkedin',
      postUrl: url,
      authorName: '',
      authorHandle: '',
      postContent: '',
      mediaUrls: [],
      extractionStatus: 'partial'
    }
  }
}

/**
 * Extract metadata from Threads posts
 *
 * Threads doesn't have a public API yet. We can only store the URL.
 */
function extractThreadsPost(url: string): SocialExtractionResult {
  // Parse URL to get username at minimum
  // Format: https://www.threads.net/@username/post/...
  try {
    const urlObj = new URL(url)
    const pathParts = urlObj.pathname.split('/').filter(Boolean)

    let authorHandle = ''
    if (pathParts.length > 0 && pathParts[0].startsWith('@')) {
      authorHandle = pathParts[0]
    }

    return {
      success: true,
      metadata: {
        platform: 'threads',
        postUrl: url,
        authorName: '',
        authorHandle,
        postContent: '',
        mediaUrls: [],
        extractionStatus: 'partial'
      }
    }
  } catch {
    return {
      success: true,
      metadata: {
        platform: 'threads',
        postUrl: url,
        authorName: '',
        authorHandle: '',
        postContent: '',
        mediaUrls: [],
        extractionStatus: 'partial'
      }
    }
  }
}

// ============================================================================
// Main Extraction Function
// ============================================================================

/**
 * Extract social media post metadata from a URL
 *
 * Detects the platform and uses the appropriate extraction method.
 * Falls back gracefully if extraction fails.
 *
 * @param url - The social media post URL
 * @returns Extraction result with metadata or error
 *
 * @example
 * const result = await extractSocialPost('https://twitter.com/user/status/123')
 * if (result.success && result.metadata) {
 *   console.log(result.metadata.authorName, result.metadata.postContent)
 * }
 */
export async function extractSocialPost(url: string): Promise<SocialExtractionResult> {
  // Detect platform
  const platform = detectSocialPlatform(url)

  if (!platform) {
    return {
      success: false,
      metadata: null,
      error: 'URL is not from a recognized social media platform'
    }
  }

  // Check if it's actually a post (not just a profile page)
  if (!isSocialPost(url)) {
    log.debug(`URL is not a post, treating as profile/page: ${url}`)
    return {
      success: true,
      metadata: {
        platform,
        postUrl: url,
        authorName: '',
        authorHandle: '',
        postContent: '',
        mediaUrls: [],
        extractionStatus: 'partial'
      }
    }
  }

  log.debug(`Extracting ${platform} post: ${url}`)

  // Route to platform-specific extractor
  switch (platform) {
    case 'twitter':
      return extractTwitterPost(url)
    case 'mastodon':
      return extractMastodonPost(url)
    case 'bluesky':
      return extractBlueskyPost(url)
    case 'linkedin':
      return extractLinkedInPost(url)
    case 'threads':
      return extractThreadsPost(url)
    default:
      return {
        success: false,
        metadata: null,
        error: `Unsupported platform: ${platform}`
      }
  }
}

/**
 * Check if a URL should be treated as a social post
 *
 * Re-exports from url-utils for convenience
 */
export { detectSocialPlatform, isSocialPost }

/**
 * Create fallback social metadata when extraction fails
 *
 * Ensures we always have some metadata to store, even if extraction fails.
 * Uses the URL as the main identifier.
 */
export function createFallbackSocialMetadata(
  url: string,
  platform: SocialPlatform | 'other',
  error?: string
): SocialMetadata {
  return {
    platform,
    postUrl: url,
    authorName: '',
    authorHandle: '',
    postContent: error ? `[Extraction failed: ${error}]` : '',
    mediaUrls: [],
    extractionStatus: 'failed'
  }
}
