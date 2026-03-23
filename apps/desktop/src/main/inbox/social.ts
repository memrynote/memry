/* eslint-disable @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-call */

import { createLogger } from '../lib/logger'
import type { SocialMetadata } from '@memry/contracts/inbox-api'
import { detectSocialPlatform, isSocialPost, type SocialPlatform } from '../lib/url-utils'

const log = createLogger('Inbox:Social')

// ============================================================================
// Types
// ============================================================================

export interface SocialExtractionResult {
  success: boolean
  metadata: SocialMetadata | null
  error?: string
}

interface TwitterOEmbedResponse {
  type: string
  version: string
  title?: string
  author_name: string
  author_url: string
  html: string
}

// ============================================================================
// Constants
// ============================================================================

const TWITTER_OEMBED_ENDPOINT = 'https://publish.twitter.com/oembed'
const FETCH_TIMEOUT = 10000

// ============================================================================
// Utility Functions
// ============================================================================

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

function parseTwitterEmbedHtml(html: string): {
  content: string
  authorName: string
  authorHandle: string
  timestamp?: string
} {
  const contentMatch = html.match(/<p[^>]*>([\s\S]*?)<\/p>/)
  let content = contentMatch ? contentMatch[1] : ''

  content = content
    .replace(/<a[^>]*>(.*?)<\/a>/g, '$1')
    .replace(/<br\s*\/?>/g, '\n')
    .replace(/&mdash;/g, '—')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/<[^>]+>/g, '')
    .trim()

  const authorMatch = html.match(/&mdash;\s*([^(]+)\s*\(@([^)]+)\)/)
  const authorName = authorMatch ? authorMatch[1].trim() : ''
  const authorHandle = authorMatch ? authorMatch[2].trim() : ''

  const timestampMatch = html.match(/<a href="[^"]*">([A-Za-z]+ \d+, \d+)<\/a>\s*<\/blockquote>/)
  const timestamp = timestampMatch ? timestampMatch[1] : undefined

  return { content, authorName, authorHandle, timestamp }
}

function extractHandleFromUrl(authorUrl: string): string {
  try {
    const url = new URL(authorUrl)
    const pathParts = url.pathname.split('/').filter(Boolean)
    return pathParts[0] || ''
  } catch {
    return ''
  }
}

function extractTweetId(url: string): string | null {
  const match = url.match(/\/status\/(\d+)/)
  return match ? match[1] : null
}

// ============================================================================
// Twitter Extraction
// ============================================================================

async function fetchTweetViaSyndication(tweetId: string): Promise<{
  text: string
  authorName: string
  authorHandle: string
  authorAvatar?: string
  timestamp?: string
  mediaUrls: string[]
} | null> {
  try {
    const syndicationUrl = `https://cdn.syndication.twimg.com/tweet-result?id=${tweetId}&lang=en&token=x`
    log.debug(`Fetching tweet via Syndication API: ${syndicationUrl}`)

    const response = await fetchWithTimeout(syndicationUrl, {
      headers: {
        Accept: 'application/json',
        'User-Agent': 'Memry/1.0'
      }
    })

    if (!response.ok) {
      log.debug(`Syndication API returned ${response.status}`)
      return null
    }

    const data = await response.json()

    log.info(`[DEBUG] Syndication API response keys: ${Object.keys(data).join(', ')}`)
    log.info(`[DEBUG] Syndication text length: ${(data.text || '').length}`)
    log.info(`[DEBUG] Syndication text:\n${data.text}`)

    if (!data.text) {
      log.debug('Syndication API returned no text')
      return null
    }

    const mediaUrls: string[] = []
    if (data.mediaDetails && Array.isArray(data.mediaDetails)) {
      for (const media of data.mediaDetails) {
        if (media.media_url_https) {
          mediaUrls.push(media.media_url_https as string)
        }
      }
    }
    if (data.photos && Array.isArray(data.photos)) {
      for (const photo of data.photos) {
        if (photo.url) {
          mediaUrls.push(photo.url as string)
        }
      }
    }

    return {
      text: data.text,
      authorName: data.user?.name || '',
      authorHandle: data.user?.screen_name || '',
      authorAvatar: data.user?.profile_image_url_https,
      timestamp: data.created_at,
      mediaUrls
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error'
    log.debug(`Syndication API failed: ${message}`)
    return null
  }
}

async function extractTwitterPost(url: string): Promise<SocialExtractionResult> {
  const tweetId = extractTweetId(url)

  if (tweetId) {
    const syndication = await fetchTweetViaSyndication(tweetId)
    if (syndication) {
      const metadata: SocialMetadata = {
        platform: 'twitter',
        postUrl: url,
        authorName: syndication.authorName || 'Unknown',
        authorHandle: syndication.authorHandle ? `@${syndication.authorHandle}` : '',
        authorAvatar: syndication.authorAvatar,
        postContent: syndication.text,
        timestamp: syndication.timestamp,
        mediaUrls: syndication.mediaUrls,
        extractionStatus: 'full'
      }

      log.info(
        `Twitter syndication extraction successful: ${metadata.authorHandle}, content length: ${metadata.postContent.length}`
      )
      return { success: true, metadata }
    }
    log.info('Syndication API failed, falling back to oEmbed')
  }

  try {
    const oembedUrl = `${TWITTER_OEMBED_ENDPOINT}?url=${encodeURIComponent(url)}&omit_script=true&dnt=true`
    log.debug(`Fetching Twitter oEmbed: ${oembedUrl}`)

    const response = await fetchWithTimeout(oembedUrl, {
      headers: {
        Accept: 'application/json',
        'User-Agent': 'Memry/1.0'
      }
    })

    if (!response.ok) {
      if (response.status === 404) {
        return { success: false, metadata: null, error: 'Tweet not found or protected' }
      }
      return { success: false, metadata: null, error: `Twitter oEmbed returned ${response.status}` }
    }

    const data = (await response.json()) as TwitterOEmbedResponse
    const parsed = parseTwitterEmbedHtml(data.html || '')
    const authorHandle = parsed.authorHandle || extractHandleFromUrl(data.author_url || '')

    const metadata: SocialMetadata = {
      platform: 'twitter',
      postUrl: url,
      authorName: data.author_name || parsed.authorName || 'Unknown',
      authorHandle: authorHandle ? `@${authorHandle}` : '',
      authorAvatar: undefined,
      postContent: parsed.content || data.title || '',
      timestamp: parsed.timestamp,
      mediaUrls: [],
      extractionStatus: parsed.content ? 'full' : 'partial'
    }

    log.info(
      `Twitter oEmbed extraction successful: @${authorHandle}, content length: ${metadata.postContent.length}`
    )
    return { success: true, metadata }
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error'
    log.error('Twitter extraction failed:', message)
    return { success: false, metadata: null, error: `Twitter extraction failed: ${message}` }
  }
}

// ============================================================================
// Main Extraction Function
// ============================================================================

export async function extractSocialPost(url: string): Promise<SocialExtractionResult> {
  const platform = detectSocialPlatform(url)

  if (!platform) {
    return {
      success: false,
      metadata: null,
      error: 'URL is not from a recognized social media platform'
    }
  }

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

  return extractTwitterPost(url)
}

export { detectSocialPlatform, isSocialPost }

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
