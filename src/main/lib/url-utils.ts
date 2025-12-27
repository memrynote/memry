/**
 * URL Validation and Parsing Utilities
 *
 * Provides utilities for URL validation, domain extraction, social platform detection,
 * and URL normalization for the inbox capture system.
 *
 * @module main/lib/url-utils
 */

// ============================================================================
// Types
// ============================================================================

export type SocialPlatform = 'twitter' | 'linkedin' | 'mastodon' | 'bluesky' | 'threads'

// ============================================================================
// URL Validation
// ============================================================================

/**
 * Validates if a string is a valid HTTP/HTTPS URL
 *
 * @param str - String to validate
 * @returns true if valid URL with http/https protocol
 *
 * @example
 * isValidUrl('https://example.com') // true
 * isValidUrl('not a url') // false
 * isValidUrl('ftp://example.com') // false
 */
export function isValidUrl(str: string): boolean {
  try {
    const url = new URL(str)
    return url.protocol === 'http:' || url.protocol === 'https:'
  } catch {
    return false
  }
}

/**
 * Attempts to parse a string as a URL, returning null if invalid
 *
 * @param str - String to parse
 * @returns URL object or null if invalid
 */
export function parseUrl(str: string): URL | null {
  try {
    return new URL(str)
  } catch {
    return null
  }
}

// ============================================================================
// Domain Extraction
// ============================================================================

/**
 * Extracts the domain from a URL (without www prefix)
 *
 * @param url - URL string to extract domain from
 * @returns Domain string or null if invalid URL
 *
 * @example
 * extractDomain('https://www.example.com/path') // 'example.com'
 * extractDomain('https://sub.example.com') // 'sub.example.com'
 */
export function extractDomain(url: string): string | null {
  try {
    const parsed = new URL(url)
    return parsed.hostname.replace(/^www\./, '')
  } catch {
    return null
  }
}

/**
 * Extracts the base domain (root domain without subdomains)
 *
 * @param url - URL string to extract base domain from
 * @returns Base domain or null if invalid URL
 *
 * @example
 * extractBaseDomain('https://blog.example.com') // 'example.com'
 * extractBaseDomain('https://www.example.co.uk') // 'example.co.uk'
 */
export function extractBaseDomain(url: string): string | null {
  const domain = extractDomain(url)
  if (!domain) return null

  // Handle common TLDs with two parts (co.uk, com.au, etc.)
  const parts = domain.split('.')
  if (parts.length <= 2) return domain

  // Check for two-part TLDs
  const twoPartTlds = ['co.uk', 'com.au', 'co.nz', 'co.jp', 'com.br', 'co.kr']
  const lastTwo = parts.slice(-2).join('.')
  if (twoPartTlds.includes(lastTwo)) {
    return parts.slice(-3).join('.')
  }

  return parts.slice(-2).join('.')
}

// ============================================================================
// Social Platform Detection
// ============================================================================

/**
 * Detects if URL is from a known social media platform
 *
 * @param url - URL string to check
 * @returns Social platform name or null if not a known social platform
 *
 * @example
 * detectSocialPlatform('https://twitter.com/user/status/123') // 'twitter'
 * detectSocialPlatform('https://x.com/user/status/123') // 'twitter'
 * detectSocialPlatform('https://example.com') // null
 */
export function detectSocialPlatform(url: string): SocialPlatform | null {
  const domain = extractDomain(url)
  if (!domain) return null

  const lowerDomain = domain.toLowerCase()

  // Twitter/X
  if (lowerDomain === 'twitter.com' || lowerDomain === 'x.com') {
    return 'twitter'
  }

  // LinkedIn
  if (lowerDomain === 'linkedin.com' || lowerDomain.endsWith('.linkedin.com')) {
    return 'linkedin'
  }

  // Threads
  if (lowerDomain === 'threads.net') {
    return 'threads'
  }

  // Bluesky
  if (lowerDomain === 'bsky.app' || lowerDomain === 'bsky.social') {
    return 'bluesky'
  }

  // Mastodon - various instances
  const mastodonIndicators = [
    'mastodon',
    'fosstodon',
    'hachyderm',
    'infosec.exchange',
    'mstdn',
    'social.coop'
  ]
  if (mastodonIndicators.some((indicator) => lowerDomain.includes(indicator))) {
    return 'mastodon'
  }

  return null
}

/**
 * Checks if URL is a social media post (not just profile or home page)
 *
 * @param url - URL to check
 * @returns true if URL appears to be a specific post/status
 */
export function isSocialPost(url: string): boolean {
  const platform = detectSocialPlatform(url)
  if (!platform) return false

  const parsed = parseUrl(url)
  if (!parsed) return false

  const path = parsed.pathname.toLowerCase()

  switch (platform) {
    case 'twitter':
      // Format: /username/status/12345
      return /\/[^/]+\/status\/\d+/.test(path)
    case 'linkedin':
      // Format: /posts/... or /feed/update/...
      return path.includes('/posts/') || path.includes('/feed/update/')
    case 'threads':
      // Format: /@username/post/...
      return path.includes('/post/')
    case 'bluesky':
      // Format: /profile/user/post/...
      return path.includes('/post/')
    case 'mastodon':
      // Format: /@username/12345 (numeric post ID)
      return /\/@[^/]+\/\d+/.test(path)
    default:
      return false
  }
}

// ============================================================================
// URL Normalization
// ============================================================================

/**
 * Common tracking parameters to remove from URLs
 */
const TRACKING_PARAMS = [
  // Google Analytics
  'utm_source',
  'utm_medium',
  'utm_campaign',
  'utm_term',
  'utm_content',
  'utm_id',
  // Facebook
  'fbclid',
  'fb_action_ids',
  'fb_action_types',
  // Google Ads
  'gclid',
  'gclsrc',
  // Twitter
  'twclid',
  // Microsoft/Bing
  'msclkid',
  // HubSpot
  'hsa_acc',
  'hsa_cam',
  'hsa_grp',
  'hsa_ad',
  'hsa_src',
  'hsa_tgt',
  'hsa_kw',
  'hsa_mt',
  'hsa_net',
  'hsa_ver',
  // Generic
  'ref',
  'ref_src',
  'ref_url',
  'source',
  'mc_cid',
  'mc_eid'
]

/**
 * Normalizes a URL by removing tracking parameters and standardizing format
 *
 * @param url - URL string to normalize
 * @returns Normalized URL string
 *
 * @example
 * normalizeUrl('https://example.com/page?utm_source=twitter&id=123')
 * // 'https://example.com/page?id=123'
 */
export function normalizeUrl(url: string): string {
  try {
    const parsed = new URL(url)

    // Remove tracking parameters
    TRACKING_PARAMS.forEach((param) => parsed.searchParams.delete(param))

    // Remove empty hash
    if (parsed.hash === '#') {
      parsed.hash = ''
    }

    return parsed.toString()
  } catch {
    return url
  }
}

// ============================================================================
// URL Type Detection
// ============================================================================

/**
 * Checks if URL points to a PDF file
 *
 * @param url - URL to check
 * @returns true if URL appears to point to a PDF
 */
export function isPdfUrl(url: string): boolean {
  try {
    const parsed = new URL(url)
    const path = parsed.pathname.toLowerCase()
    return path.endsWith('.pdf')
  } catch {
    return false
  }
}

/**
 * Checks if URL points to an image file
 *
 * @param url - URL to check
 * @returns true if URL appears to point to an image
 */
export function isImageUrl(url: string): boolean {
  try {
    const parsed = new URL(url)
    const path = parsed.pathname.toLowerCase()
    const imageExtensions = ['.jpg', '.jpeg', '.png', '.gif', '.webp', '.svg', '.bmp', '.ico']
    return imageExtensions.some((ext) => path.endsWith(ext))
  } catch {
    return false
  }
}

/**
 * Checks if URL points to a video file
 *
 * @param url - URL to check
 * @returns true if URL appears to point to a video
 */
export function isVideoUrl(url: string): boolean {
  try {
    const parsed = new URL(url)
    const path = parsed.pathname.toLowerCase()
    const videoExtensions = ['.mp4', '.webm', '.mov', '.avi', '.mkv', '.m4v']
    return videoExtensions.some((ext) => path.endsWith(ext))
  } catch {
    return false
  }
}

/**
 * Checks if URL points to an audio file
 *
 * @param url - URL to check
 * @returns true if URL appears to point to an audio file
 */
export function isAudioUrl(url: string): boolean {
  try {
    const parsed = new URL(url)
    const path = parsed.pathname.toLowerCase()
    const audioExtensions = ['.mp3', '.wav', '.ogg', '.m4a', '.aac', '.flac', '.webm']
    return audioExtensions.some((ext) => path.endsWith(ext))
  } catch {
    return false
  }
}

/**
 * Determines the likely content type of a URL
 *
 * @param url - URL to analyze
 * @returns Content type hint
 */
export function getUrlContentType(
  url: string
): 'pdf' | 'image' | 'video' | 'audio' | 'social' | 'webpage' {
  if (isPdfUrl(url)) return 'pdf'
  if (isImageUrl(url)) return 'image'
  if (isVideoUrl(url)) return 'video'
  if (isAudioUrl(url)) return 'audio'
  if (detectSocialPlatform(url)) return 'social'
  return 'webpage'
}
