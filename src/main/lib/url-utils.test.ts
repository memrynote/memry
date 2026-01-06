import { describe, it, expect } from 'vitest'
import {
  isValidUrl,
  parseUrl,
  extractDomain,
  extractBaseDomain,
  detectSocialPlatform,
  isSocialPost,
  normalizeUrl,
  isPdfUrl,
  isImageUrl,
  isVideoUrl,
  isAudioUrl,
  getUrlContentType
} from './url-utils'

describe('url-utils', () => {
  describe('isValidUrl and parseUrl', () => {
    it('validates http/https urls and rejects others', () => {
      expect(isValidUrl('https://example.com')).toBe(true)
      expect(isValidUrl('http://example.com')).toBe(true)
      expect(isValidUrl('ftp://example.com')).toBe(false)
      expect(isValidUrl('not a url')).toBe(false)
    })

    it('parses valid urls and returns null for invalid', () => {
      const parsed = parseUrl('https://example.com/path')
      expect(parsed?.hostname).toBe('example.com')
      expect(parseUrl('not a url')).toBeNull()
    })
  })

  describe('domain extraction', () => {
    it('extracts domain and base domain correctly', () => {
      expect(extractDomain('https://www.example.com/path')).toBe('example.com')
      expect(extractDomain('https://sub.example.com')).toBe('sub.example.com')
      expect(extractDomain('not a url')).toBeNull()

      expect(extractBaseDomain('https://blog.example.com')).toBe('example.com')
      expect(extractBaseDomain('https://www.example.co.uk')).toBe('example.co.uk')
      expect(extractBaseDomain('https://sub.example.co.jp')).toBe('example.co.jp')
    })
  })

  describe('social platform detection', () => {
    it('detects common social platforms', () => {
      expect(detectSocialPlatform('https://twitter.com/user/status/123')).toBe('twitter')
      expect(detectSocialPlatform('https://x.com/user/status/123')).toBe('twitter')
      expect(detectSocialPlatform('https://www.linkedin.com/feed/update/123')).toBe(
        'linkedin'
      )
      expect(detectSocialPlatform('https://threads.net/@user/post/123')).toBe('threads')
      expect(detectSocialPlatform('https://bsky.app/profile/user/post/123')).toBe('bluesky')
      expect(detectSocialPlatform('https://mastodon.social/@user/123')).toBe('mastodon')
      expect(detectSocialPlatform('https://example.com')).toBeNull()
    })

    it('identifies social post urls', () => {
      expect(isSocialPost('https://twitter.com/user/status/123')).toBe(true)
      expect(isSocialPost('https://twitter.com/user')).toBe(false)
      expect(isSocialPost('https://www.linkedin.com/feed/update/123')).toBe(true)
      expect(isSocialPost('https://www.linkedin.com/in/user')).toBe(false)
      expect(isSocialPost('https://threads.net/@user/post/123')).toBe(true)
      expect(isSocialPost('https://bsky.app/profile/user/post/123')).toBe(true)
      expect(isSocialPost('https://mastodon.social/@user/123')).toBe(true)
      expect(isSocialPost('https://example.com')).toBe(false)
    })
  })

  describe('normalizeUrl', () => {
    it('removes tracking parameters and empty hash', () => {
      const input = 'https://example.com/page?utm_source=twitter&id=123&fbclid=abc'
      expect(normalizeUrl(input)).toBe('https://example.com/page?id=123')
    })

    it('returns original string for invalid urls', () => {
      expect(normalizeUrl('not a url')).toBe('not a url')
    })
  })

  describe('type detection', () => {
    it('detects file types from url extension', () => {
      expect(isPdfUrl('https://example.com/file.pdf')).toBe(true)
      expect(isImageUrl('https://example.com/image.PNG')).toBe(true)
      expect(isVideoUrl('https://example.com/video.mp4')).toBe(true)
      expect(isAudioUrl('https://example.com/audio.MP3')).toBe(true)

      expect(isPdfUrl('https://example.com/page')).toBe(false)
      expect(isImageUrl('https://example.com/page')).toBe(false)
      expect(isVideoUrl('https://example.com/page')).toBe(false)
      expect(isAudioUrl('https://example.com/page')).toBe(false)
    })

    it('returns a content type hint', () => {
      expect(getUrlContentType('https://example.com/file.pdf')).toBe('pdf')
      expect(getUrlContentType('https://example.com/image.jpg')).toBe('image')
      expect(getUrlContentType('https://example.com/video.mp4')).toBe('video')
      expect(getUrlContentType('https://example.com/audio.mp3')).toBe('audio')
      expect(getUrlContentType('https://twitter.com/user/status/123')).toBe('social')
      expect(getUrlContentType('https://example.com/page')).toBe('webpage')
    })
  })
})
