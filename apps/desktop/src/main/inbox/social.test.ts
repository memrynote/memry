import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import {
  extractSocialPost,
  detectSocialPlatform,
  isSocialPost,
  createFallbackSocialMetadata
} from './social'

const mockFetch = vi.fn()
global.fetch = mockFetch

vi.mock('../lib/url-utils', () => ({
  detectSocialPlatform: vi.fn(),
  isSocialPost: vi.fn(),
  extractDomain: vi.fn((url) => {
    try {
      return new URL(url).hostname
    } catch {
      return url
    }
  })
}))

import {
  detectSocialPlatform as mockDetectSocialPlatform,
  isSocialPost as mockIsSocialPost
} from '../lib/url-utils'

describe('Social Media Post Extraction', () => {
  beforeEach(() => {
    mockFetch.mockReset()
    vi.mocked(mockDetectSocialPlatform).mockReset()
    vi.mocked(mockIsSocialPost).mockReset()
  })

  afterEach(() => {
    vi.clearAllMocks()
  })

  describe('Platform Detection', () => {
    it('should detect Twitter/X URLs', () => {
      vi.mocked(mockDetectSocialPlatform).mockReturnValue('twitter')
      expect(detectSocialPlatform('https://twitter.com/user/status/123')).toBe('twitter')
      expect(detectSocialPlatform('https://x.com/user/status/123')).toBe('twitter')
    })

    it('should return null for non-social URLs', () => {
      vi.mocked(mockDetectSocialPlatform).mockReturnValue(null)
      expect(detectSocialPlatform('https://example.com')).toBeNull()
    })

    it('should identify post URLs vs profile URLs', () => {
      vi.mocked(mockIsSocialPost).mockReturnValueOnce(true).mockReturnValueOnce(false)

      expect(isSocialPost('https://twitter.com/user/status/123')).toBe(true)
      expect(isSocialPost('https://twitter.com/user')).toBe(false)
    })
  })

  describe('extractSocialPost - Twitter/X', () => {
    beforeEach(() => {
      vi.mocked(mockDetectSocialPlatform).mockReturnValue('twitter')
      vi.mocked(mockIsSocialPost).mockReturnValue(true)
    })

    it('should extract metadata from Twitter oEmbed', async () => {
      const oembedResponse = {
        author_name: 'Test User',
        author_url: 'https://twitter.com/testuser',
        html: '<blockquote class="twitter-tweet"><p lang="en" dir="ltr">This is a test tweet!</p>&mdash; Test User (@testuser) <a href="https://twitter.com/testuser/status/123">December 28, 2025</a></blockquote>'
      }

      mockFetch.mockResolvedValueOnce({ ok: false, status: 500 }).mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve(oembedResponse)
      })

      const result = await extractSocialPost('https://twitter.com/testuser/status/123')

      expect(result.success).toBe(true)
      expect(result.metadata).toBeDefined()
      expect(result.metadata?.platform).toBe('twitter')
      expect(result.metadata?.authorName).toBe('Test User')
      expect(result.metadata?.authorHandle).toBe('@testuser')
      expect(result.metadata?.postContent).toContain('test tweet')
    })

    it('should handle protected/deleted tweets', async () => {
      mockFetch
        .mockResolvedValueOnce({ ok: false, status: 404 })
        .mockResolvedValueOnce({ ok: false, status: 404 })

      const result = await extractSocialPost('https://twitter.com/user/status/deleted')

      expect(result.success).toBe(false)
      expect(result.error).toContain('not found')
    })

    it('should handle Twitter API errors', async () => {
      mockFetch
        .mockResolvedValueOnce({ ok: false, status: 500 })
        .mockResolvedValueOnce({ ok: false, status: 500 })

      const result = await extractSocialPost('https://twitter.com/user/status/123')

      expect(result.success).toBe(false)
      expect(result.error).toContain('500')
    })

    it('should parse HTML entities in tweet content', async () => {
      const oembedResponse = {
        author_name: 'User',
        author_url: 'https://twitter.com/user',
        html: '<blockquote class="twitter-tweet"><p>Test &amp; more</p>&mdash; User (@user) <a href="#">Date</a></blockquote>'
      }

      mockFetch.mockResolvedValueOnce({ ok: false, status: 500 }).mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve(oembedResponse)
      })

      const result = await extractSocialPost('https://twitter.com/user/status/123')

      expect(result.metadata?.postContent).toContain('&')
      expect(result.metadata?.postContent).toContain('more')
    })
  })

  describe('createFallbackSocialMetadata', () => {
    it('should create fallback metadata with URL', () => {
      const fallback = createFallbackSocialMetadata(
        'https://twitter.com/user/status/123',
        'twitter'
      )

      expect(fallback.platform).toBe('twitter')
      expect(fallback.postUrl).toBe('https://twitter.com/user/status/123')
      expect(fallback.extractionStatus).toBe('failed')
    })

    it('should include error message in content when provided', () => {
      const fallback = createFallbackSocialMetadata(
        'https://twitter.com/user/status/123',
        'twitter',
        'API timeout'
      )

      expect(fallback.postContent).toContain('API timeout')
    })

    it('should handle "other" platform type', () => {
      const fallback = createFallbackSocialMetadata('https://unknown.social/post', 'other')

      expect(fallback.platform).toBe('other')
    })
  })

  describe('extractSocialPost - Edge Cases', () => {
    it('should return error for unrecognized platform', async () => {
      vi.mocked(mockDetectSocialPlatform).mockReturnValue(null)

      const result = await extractSocialPost('https://example.com/not-social')

      expect(result.success).toBe(false)
      expect(result.error).toContain('not from a recognized')
    })

    it('should handle non-post URLs (profile pages)', async () => {
      vi.mocked(mockDetectSocialPlatform).mockReturnValue('twitter')
      vi.mocked(mockIsSocialPost).mockReturnValue(false)

      const result = await extractSocialPost('https://twitter.com/user')

      expect(result.success).toBe(true)
      expect(result.metadata?.extractionStatus).toBe('partial')
    })

    it('should handle network timeouts gracefully', async () => {
      vi.mocked(mockDetectSocialPlatform).mockReturnValue('twitter')
      vi.mocked(mockIsSocialPost).mockReturnValue(true)

      mockFetch
        .mockRejectedValueOnce(new Error('Network timeout'))
        .mockRejectedValueOnce(new Error('Network timeout'))

      const result = await extractSocialPost('https://twitter.com/user/status/123')

      expect(result.success).toBe(false)
      expect(result.error).toContain('timeout')
    })

    it('should handle AbortError for timeouts', async () => {
      vi.mocked(mockDetectSocialPlatform).mockReturnValue('twitter')
      vi.mocked(mockIsSocialPost).mockReturnValue(true)

      const abortError = new Error('Aborted')
      abortError.name = 'AbortError'
      mockFetch.mockRejectedValueOnce(abortError).mockRejectedValueOnce(abortError)

      const result = await extractSocialPost('https://twitter.com/user/status/123')

      expect(result.success).toBe(false)
    })
  })
})
