import { extractDomain as extractDomainNullable } from '../lib/url-utils'

const BOT_PAGE_TITLES = [
  'just a moment...',
  'attention required!',
  'access denied',
  'please wait',
  'verify you are human',
  'checking your browser'
]

export function extractDomain(url: string): string {
  return extractDomainNullable(url) ?? url
}

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
