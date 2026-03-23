import { describe, it, expect, beforeEach, vi } from 'vitest'
import {
  extractSocialPost,
  detectSocialPlatform,
  isSocialPost,
  createFallbackSocialMetadata
} from './social'

vi.mock('../lib/url-utils', () => ({
  detectSocialPlatform: vi.fn(),
  isSocialPost: vi.fn()
}))

import {
  detectSocialPlatform as mockDetectSocialPlatform,
  isSocialPost as mockIsSocialPost
} from '../lib/url-utils'

describe('Social Media Post Extraction', () => {
  beforeEach(() => {
    vi.mocked(mockDetectSocialPlatform).mockReset()
    vi.mocked(mockIsSocialPost).mockReset()
  })

  describe('Platform Detection (re-exports)', () => {
    it('should re-export detectSocialPlatform', () => {
      vi.mocked(mockDetectSocialPlatform).mockReturnValue('twitter')
      expect(detectSocialPlatform('https://twitter.com/user/status/123')).toBe('twitter')
    })

    it('should re-export isSocialPost', () => {
      vi.mocked(mockIsSocialPost).mockReturnValue(true)
      expect(isSocialPost('https://twitter.com/user/status/123')).toBe(true)
    })
  })

  describe('extractSocialPost', () => {
    it('should return error for non-social URLs', () => {
      vi.mocked(mockDetectSocialPlatform).mockReturnValue(null)

      const result = extractSocialPost('https://example.com/not-social')

      expect(result.success).toBe(false)
      expect(result.error).toContain('not from a recognized')
    })

    it('should return partial metadata for profile URLs (not posts)', () => {
      vi.mocked(mockDetectSocialPlatform).mockReturnValue('twitter')
      vi.mocked(mockIsSocialPost).mockReturnValue(false)

      const result = extractSocialPost('https://twitter.com/user')

      expect(result.success).toBe(true)
      expect(result.metadata?.extractionStatus).toBe('partial')
      expect(result.metadata?.tweetId).toBeUndefined()
    })

    it('should extract tweetId from twitter.com status URL', () => {
      vi.mocked(mockDetectSocialPlatform).mockReturnValue('twitter')
      vi.mocked(mockIsSocialPost).mockReturnValue(true)

      const result = extractSocialPost('https://twitter.com/elonmusk/status/1234567890')

      expect(result.success).toBe(true)
      expect(result.metadata?.tweetId).toBe('1234567890')
      expect(result.metadata?.platform).toBe('twitter')
      expect(result.metadata?.postUrl).toBe('https://twitter.com/elonmusk/status/1234567890')
    })

    it('should extract tweetId from x.com status URL', () => {
      vi.mocked(mockDetectSocialPlatform).mockReturnValue('twitter')
      vi.mocked(mockIsSocialPost).mockReturnValue(true)

      const result = extractSocialPost('https://x.com/user/status/9876543210')

      expect(result.success).toBe(true)
      expect(result.metadata?.tweetId).toBe('9876543210')
    })

    it('should handle URLs with query params and fragments', () => {
      vi.mocked(mockDetectSocialPlatform).mockReturnValue('twitter')
      vi.mocked(mockIsSocialPost).mockReturnValue(true)

      const result = extractSocialPost('https://twitter.com/user/status/111222333?s=20&t=abc#top')

      expect(result.success).toBe(true)
      expect(result.metadata?.tweetId).toBe('111222333')
    })

    it('should extract handle from URL path', () => {
      vi.mocked(mockDetectSocialPlatform).mockReturnValue('twitter')
      vi.mocked(mockIsSocialPost).mockReturnValue(true)

      const result = extractSocialPost('https://twitter.com/rauchg/status/123456')

      expect(result.metadata?.authorHandle).toBe('@rauchg')
    })

    it('should be synchronous (no network requests)', () => {
      vi.mocked(mockDetectSocialPlatform).mockReturnValue('twitter')
      vi.mocked(mockIsSocialPost).mockReturnValue(true)

      const mockFetch = vi.fn()
      global.fetch = mockFetch

      extractSocialPost('https://twitter.com/user/status/123')

      expect(mockFetch).not.toHaveBeenCalled()
    })

    it('should set extractionStatus to partial (react-tweet handles full fetch)', () => {
      vi.mocked(mockDetectSocialPlatform).mockReturnValue('twitter')
      vi.mocked(mockIsSocialPost).mockReturnValue(true)

      const result = extractSocialPost('https://twitter.com/user/status/123')

      expect(result.metadata?.extractionStatus).toBe('partial')
    })

    it('should return empty postContent (react-tweet handles display)', () => {
      vi.mocked(mockDetectSocialPlatform).mockReturnValue('twitter')
      vi.mocked(mockIsSocialPost).mockReturnValue(true)

      const result = extractSocialPost('https://twitter.com/user/status/123')

      expect(result.metadata?.postContent).toBe('')
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
})
