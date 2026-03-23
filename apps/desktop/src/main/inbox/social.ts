import type { SocialMetadata } from '@memry/contracts/inbox-api'
import { detectSocialPlatform, isSocialPost, type SocialPlatform } from '../lib/url-utils'

export interface SocialExtractionResult {
  success: boolean
  metadata: SocialMetadata | null
  error?: string
}

function extractTweetId(url: string): string | null {
  const match = url.match(/\/status\/(\d+)/)
  return match ? match[1] : null
}

function extractHandleFromPath(url: string): string {
  try {
    const pathParts = new URL(url).pathname.split('/').filter(Boolean)
    return pathParts[0] ? `@${pathParts[0]}` : ''
  } catch {
    return ''
  }
}

export function extractSocialPost(url: string): SocialExtractionResult {
  const platform = detectSocialPlatform(url)

  if (!platform) {
    return {
      success: false,
      metadata: null,
      error: 'URL is not from a recognized social media platform'
    }
  }

  if (!isSocialPost(url)) {
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

  const tweetId = extractTweetId(url) ?? undefined
  const authorHandle = extractHandleFromPath(url)

  return {
    success: true,
    metadata: {
      platform: 'twitter',
      tweetId,
      postUrl: url,
      authorName: '',
      authorHandle,
      postContent: '',
      mediaUrls: [],
      extractionStatus: 'partial'
    }
  }
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
