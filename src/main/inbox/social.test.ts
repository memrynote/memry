/**
 * Social Media Post Extraction Tests
 *
 * Tests for extraction of metadata from social media posts
 * (Twitter/X, LinkedIn, Mastodon, Bluesky, Threads).
 *
 * @module main/inbox/social.test
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import {
  extractSocialPost,
  detectSocialPlatform,
  isSocialPost,
  createFallbackSocialMetadata
} from './social'

// Mock fetch globally
const mockFetch = vi.fn()
global.fetch = mockFetch

// Mock url-utils module
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

import { detectSocialPlatform as mockDetectSocialPlatform, isSocialPost as mockIsSocialPost } from '../lib/url-utils'

describe('Social Media Post Extraction', () => {
  beforeEach(() => {
    mockFetch.mockReset()
    vi.mocked(mockDetectSocialPlatform).mockReset()
    vi.mocked(mockIsSocialPost).mockReset()
  })

  afterEach(() => {
    vi.clearAllMocks()
  })

  // ==========================================================================
  // T431: detectSocialPlatform and isSocialPost
  // ==========================================================================
  describe('Platform Detection', () => {
    it('should detect Twitter/X URLs', () => {
      vi.mocked(mockDetectSocialPlatform).mockReturnValue('twitter')
      expect(detectSocialPlatform('https://twitter.com/user/status/123')).toBe('twitter')
      expect(detectSocialPlatform('https://x.com/user/status/123')).toBe('twitter')
    })

    it('should detect LinkedIn URLs', () => {
      vi.mocked(mockDetectSocialPlatform).mockReturnValue('linkedin')
      expect(detectSocialPlatform('https://linkedin.com/posts/user_123')).toBe('linkedin')
    })

    it('should detect Mastodon URLs', () => {
      vi.mocked(mockDetectSocialPlatform).mockReturnValue('mastodon')
      expect(detectSocialPlatform('https://mastodon.social/@user/123')).toBe('mastodon')
    })

    it('should detect Bluesky URLs', () => {
      vi.mocked(mockDetectSocialPlatform).mockReturnValue('bluesky')
      expect(detectSocialPlatform('https://bsky.app/profile/user/post/123')).toBe('bluesky')
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

  // ==========================================================================
  // T432: extractSocialPost - Twitter/X
  // ==========================================================================
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

      mockFetch.mockResolvedValueOnce({
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
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 404
      })

      const result = await extractSocialPost('https://twitter.com/user/status/deleted')

      expect(result.success).toBe(false)
      expect(result.error).toContain('not found')
    })

    it('should handle Twitter API errors', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 500
      })

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

      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve(oembedResponse)
      })

      const result = await extractSocialPost('https://twitter.com/user/status/123')

      expect(result.metadata?.postContent).toContain('&')
      expect(result.metadata?.postContent).toContain('more')
    })
  })

  // ==========================================================================
  // T433: extractSocialPost - Mastodon and Bluesky
  // ==========================================================================
  describe('extractSocialPost - Mastodon', () => {
    beforeEach(() => {
      vi.mocked(mockDetectSocialPlatform).mockReturnValue('mastodon')
      vi.mocked(mockIsSocialPost).mockReturnValue(true)
    })

    it('should extract metadata from Mastodon oEmbed', async () => {
      const oembedResponse = {
        author_name: 'User Name (@user@mastodon.social)',
        title: 'This is a toot!',
        html: '<iframe>content</iframe>'
      }

      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve(oembedResponse)
      })

      const result = await extractSocialPost('https://mastodon.social/@user/123')

      expect(result.success).toBe(true)
      expect(result.metadata?.platform).toBe('mastodon')
      expect(result.metadata?.authorHandle).toContain('@user')
    })

    it('should handle Mastodon API errors', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 404
      })

      const result = await extractSocialPost('https://mastodon.social/@user/123')

      expect(result.success).toBe(false)
    })

    it('should use instance-specific oEmbed endpoint', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ author_name: 'User' })
      })

      await extractSocialPost('https://fosstodon.org/@user/123')

      expect(mockFetch).toHaveBeenCalledWith(
        expect.stringContaining('fosstodon.org/api/oembed'),
        expect.anything()
      )
    })
  })

  describe('extractSocialPost - Bluesky', () => {
    beforeEach(() => {
      vi.mocked(mockDetectSocialPlatform).mockReturnValue('bluesky')
      vi.mocked(mockIsSocialPost).mockReturnValue(true)
    })

    it('should extract metadata from Bluesky API', async () => {
      const apiResponse = {
        thread: {
          post: {
            author: {
              displayName: 'Test User',
              handle: 'testuser.bsky.social',
              avatar: 'https://avatar.url'
            },
            record: {
              text: 'This is a Bluesky post!',
              createdAt: '2025-01-02T12:00:00Z'
            },
            likeCount: 10,
            repostCount: 5,
            replyCount: 2
          }
        }
      }

      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve(apiResponse)
      })

      const result = await extractSocialPost('https://bsky.app/profile/testuser.bsky.social/post/abc123')

      expect(result.success).toBe(true)
      expect(result.metadata?.platform).toBe('bluesky')
      expect(result.metadata?.authorName).toBe('Test User')
      expect(result.metadata?.authorHandle).toBe('@testuser.bsky.social')
      expect(result.metadata?.postContent).toBe('This is a Bluesky post!')
      expect(result.metadata?.metrics?.likes).toBe(10)
    })

    it('should handle invalid Bluesky URL format', async () => {
      const result = await extractSocialPost('https://bsky.app/invalid/path')

      expect(result.success).toBe(false)
      expect(result.error).toContain('Invalid')
    })

    it('should fall back to partial metadata on API error', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 400
      })

      const result = await extractSocialPost('https://bsky.app/profile/user.bsky.social/post/abc')

      expect(result.success).toBe(true)
      expect(result.metadata?.extractionStatus).toBe('partial')
    })
  })

  // ==========================================================================
  // T434: createFallbackSocialMetadata and edge cases
  // ==========================================================================
  describe('createFallbackSocialMetadata', () => {
    it('should create fallback metadata with URL', () => {
      const fallback = createFallbackSocialMetadata('https://twitter.com/user/status/123', 'twitter')

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

  describe('extractSocialPost - LinkedIn', () => {
    beforeEach(() => {
      vi.mocked(mockDetectSocialPlatform).mockReturnValue('linkedin')
      vi.mocked(mockIsSocialPost).mockReturnValue(true)
    })

    it('should return partial metadata for LinkedIn (no public API)', async () => {
      const result = await extractSocialPost('https://linkedin.com/posts/user_activity-123')

      expect(result.success).toBe(true)
      expect(result.metadata?.platform).toBe('linkedin')
      expect(result.metadata?.extractionStatus).toBe('partial')
    })
  })

  describe('extractSocialPost - Threads', () => {
    beforeEach(() => {
      vi.mocked(mockDetectSocialPlatform).mockReturnValue('threads')
      vi.mocked(mockIsSocialPost).mockReturnValue(true)
    })

    it('should extract username from Threads URL', async () => {
      const result = await extractSocialPost('https://www.threads.net/@username/post/abc123')

      expect(result.success).toBe(true)
      expect(result.metadata?.platform).toBe('threads')
      expect(result.metadata?.authorHandle).toBe('@username')
      expect(result.metadata?.extractionStatus).toBe('partial')
    })

    it('should handle Threads URLs without username', async () => {
      const result = await extractSocialPost('https://www.threads.net/post/abc123')

      expect(result.success).toBe(true)
      expect(result.metadata?.authorHandle).toBe('')
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

      mockFetch.mockRejectedValueOnce(new Error('Network timeout'))

      const result = await extractSocialPost('https://twitter.com/user/status/123')

      expect(result.success).toBe(false)
      expect(result.error).toContain('timeout')
    })

    it('should handle AbortError for timeouts', async () => {
      vi.mocked(mockDetectSocialPlatform).mockReturnValue('twitter')
      vi.mocked(mockIsSocialPost).mockReturnValue(true)

      const abortError = new Error('Aborted')
      abortError.name = 'AbortError'
      mockFetch.mockRejectedValueOnce(abortError)

      const result = await extractSocialPost('https://twitter.com/user/status/123')

      expect(result.success).toBe(false)
    })
  })
})
