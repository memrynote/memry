/**
 * Platform detection + display helpers for the social card.
 *
 * @module components/social-card-utils
 */

export type SocialPlatform = 'twitter' | 'other'

function getHostname(url: string | null): string | null {
  if (!url) return null

  try {
    return new URL(url).hostname.toLowerCase() || null
  } catch {
    if (typeof document === 'undefined') return null

    const anchor = document.createElement('a')
    anchor.href = url
    return anchor.hostname.toLowerCase() || null
  }
}

function getPathname(url: string | null): string {
  if (!url) return ''

  try {
    return new URL(url).pathname
  } catch {
    if (typeof document === 'undefined') return ''

    const anchor = document.createElement('a')
    anchor.href = url
    return anchor.pathname
  }
}

function isTwitterHostname(hostname: string | null): boolean {
  if (!hostname) return false

  return (
    hostname === 'twitter.com' ||
    hostname.endsWith('.twitter.com') ||
    hostname === 'x.com' ||
    hostname.endsWith('.x.com')
  )
}

export function detectPlatformFromUrl(url: string | null): SocialPlatform {
  if (isTwitterHostname(getHostname(url))) return 'twitter'

  return 'other'
}

/**
 * Extract handle from URL
 */
export function extractHandleFromUrl(url: string | null): string {
  if (!url) return ''

  const hostname = getHostname(url)
  if (!isTwitterHostname(hostname)) return ''

  const pathParts = getPathname(url).split('/').filter(Boolean)
  return pathParts[0] ? `@${pathParts[0]}` : ''
}

/**
 * Get platform display name
 */
export function getPlatformName(platform: SocialPlatform): string {
  switch (platform) {
    case 'twitter':
      return 'X'
    default:
      return 'Social'
  }
}

/**
 * Get platform color for accents
 */
export function getPlatformColor(platform: SocialPlatform): string {
  switch (platform) {
    case 'twitter':
      return 'text-[#1DA1F2]'
    default:
      return 'text-[var(--muted-foreground)]'
  }
}
