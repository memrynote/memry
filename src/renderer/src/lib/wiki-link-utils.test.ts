import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import {
  formatWikiLinkTitle,
  parseWikiLinkSyntax,
  createWikiLinkHTML,
  formatRelativeTime,
  type WikiLinkData
} from './wiki-link-utils'

describe('wiki-link-utils', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date(2026, 0, 15, 12, 0, 0)) // January 15, 2026, 12:00:00
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  describe('formatWikiLinkTitle', () => {
    it('should return trimmed title', () => {
      expect(formatWikiLinkTitle('  My Note  ')).toBe('My Note')
    })

    it('should handle title with no extra whitespace', () => {
      expect(formatWikiLinkTitle('My Note')).toBe('My Note')
    })

    it('should handle empty string', () => {
      expect(formatWikiLinkTitle('')).toBe('')
    })

    it('should handle string with only whitespace', () => {
      expect(formatWikiLinkTitle('   ')).toBe('')
    })

    it('should preserve internal whitespace', () => {
      expect(formatWikiLinkTitle('  My   Note   Title  ')).toBe('My   Note   Title')
    })

    it('should handle tabs and newlines', () => {
      expect(formatWikiLinkTitle('\tMy Note\n')).toBe('My Note')
    })
  })

  describe('parseWikiLinkSyntax', () => {
    it('should parse simple wiki link', () => {
      expect(parseWikiLinkSyntax('[[My Note]]')).toBe('My Note')
    })

    it('should parse wiki link with spaces', () => {
      expect(parseWikiLinkSyntax('[[  My Note  ]]')).toBe('My Note')
    })

    it('should return null for invalid syntax - missing brackets', () => {
      expect(parseWikiLinkSyntax('[My Note]')).toBeNull()
    })

    it('should return null for invalid syntax - only opening brackets', () => {
      expect(parseWikiLinkSyntax('[[My Note')).toBeNull()
    })

    it('should return null for plain text', () => {
      expect(parseWikiLinkSyntax('My Note')).toBeNull()
    })

    it('should return null for empty brackets', () => {
      expect(parseWikiLinkSyntax('[[]]')).toBeNull()
    })

    it('should handle wiki link with special characters', () => {
      expect(parseWikiLinkSyntax('[[My Note: Part 1]]')).toBe('My Note: Part 1')
    })

    it('should handle wiki link with pipe (not extracting alias)', () => {
      expect(parseWikiLinkSyntax('[[target|alias]]')).toBe('target|alias')
    })

    it('should return null if there is text before brackets', () => {
      expect(parseWikiLinkSyntax('text [[My Note]]')).toBeNull()
    })

    it('should return null if there is text after brackets', () => {
      expect(parseWikiLinkSyntax('[[My Note]] text')).toBeNull()
    })
  })

  describe('createWikiLinkHTML', () => {
    it('should create HTML for existing wiki link', () => {
      const data: WikiLinkData = {
        href: 'note-123',
        title: 'My Note',
        exists: true
      }
      const html = createWikiLinkHTML(data)
      expect(html).toBe(
        '<span class="wiki-link" data-wiki-link data-href="note-123" data-title="My Note">My Note</span>'
      )
    })

    it('should create HTML for non-existing wiki link with broken class', () => {
      const data: WikiLinkData = {
        href: 'note-456',
        title: 'Missing Note',
        exists: false
      }
      const html = createWikiLinkHTML(data)
      expect(html).toBe(
        '<span class="wiki-link wiki-link-broken" data-wiki-link data-href="note-456" data-title="Missing Note">Missing Note</span>'
      )
    })

    it('should escape title with special characters in attributes', () => {
      const data: WikiLinkData = {
        href: 'note-789',
        title: 'Note "with" quotes',
        exists: true
      }
      const html = createWikiLinkHTML(data)
      expect(html).toContain('data-title="Note "with" quotes"')
    })

    it('should handle empty title', () => {
      const data: WikiLinkData = {
        href: 'note-empty',
        title: '',
        exists: true
      }
      const html = createWikiLinkHTML(data)
      expect(html).toBe(
        '<span class="wiki-link" data-wiki-link data-href="note-empty" data-title=""></span>'
      )
    })
  })

  describe('formatRelativeTime', () => {
    it('should return "just now" for time less than a minute ago', () => {
      const date = new Date(2026, 0, 15, 11, 59, 30).toISOString()
      expect(formatRelativeTime(date)).toBe('just now')
    })

    it('should return "1 minute ago" for exactly 1 minute ago', () => {
      const date = new Date(2026, 0, 15, 11, 59, 0).toISOString()
      expect(formatRelativeTime(date)).toBe('1 minute ago')
    })

    it('should return "2 minutes ago" for 2 minutes ago', () => {
      const date = new Date(2026, 0, 15, 11, 58, 0).toISOString()
      expect(formatRelativeTime(date)).toBe('2 minutes ago')
    })

    it('should return "59 minutes ago" for 59 minutes ago', () => {
      const date = new Date(2026, 0, 15, 11, 1, 0).toISOString()
      expect(formatRelativeTime(date)).toBe('59 minutes ago')
    })

    it('should return "1 hour ago" for exactly 1 hour ago', () => {
      const date = new Date(2026, 0, 15, 11, 0, 0).toISOString()
      expect(formatRelativeTime(date)).toBe('1 hour ago')
    })

    it('should return "2 hours ago" for 2 hours ago', () => {
      const date = new Date(2026, 0, 15, 10, 0, 0).toISOString()
      expect(formatRelativeTime(date)).toBe('2 hours ago')
    })

    it('should return "23 hours ago" for 23 hours ago', () => {
      const date = new Date(2026, 0, 14, 13, 0, 0).toISOString()
      expect(formatRelativeTime(date)).toBe('23 hours ago')
    })

    it('should return "1 day ago" for exactly 1 day ago', () => {
      const date = new Date(2026, 0, 14, 12, 0, 0).toISOString()
      expect(formatRelativeTime(date)).toBe('1 day ago')
    })

    it('should return "3 days ago" for 3 days ago', () => {
      const date = new Date(2026, 0, 12, 12, 0, 0).toISOString()
      expect(formatRelativeTime(date)).toBe('3 days ago')
    })

    it('should return "6 days ago" for 6 days ago', () => {
      const date = new Date(2026, 0, 9, 12, 0, 0).toISOString()
      expect(formatRelativeTime(date)).toBe('6 days ago')
    })

    it('should return "1 week ago" for exactly 1 week ago', () => {
      const date = new Date(2026, 0, 8, 12, 0, 0).toISOString()
      expect(formatRelativeTime(date)).toBe('1 week ago')
    })

    it('should return "2 weeks ago" for 2 weeks ago', () => {
      const date = new Date(2026, 0, 1, 12, 0, 0).toISOString()
      expect(formatRelativeTime(date)).toBe('2 weeks ago')
    })

    it('should return "3 weeks ago" for 3 weeks ago', () => {
      const date = new Date(2025, 11, 25, 12, 0, 0).toISOString()
      expect(formatRelativeTime(date)).toBe('3 weeks ago')
    })

    it('should return "1 month ago" for exactly 1 month ago', () => {
      const date = new Date(2025, 11, 16, 12, 0, 0).toISOString() // 30 days ago
      expect(formatRelativeTime(date)).toBe('1 month ago')
    })

    it('should return "2 months ago" for 2 months ago', () => {
      const date = new Date(2025, 10, 16, 12, 0, 0).toISOString() // ~60 days ago
      expect(formatRelativeTime(date)).toBe('2 months ago')
    })

    it('should return "6 months ago" for 6 months ago', () => {
      const date = new Date(2025, 6, 15, 12, 0, 0).toISOString()
      expect(formatRelativeTime(date)).toBe('6 months ago')
    })

    it('should return "11 months ago" for 11 months ago', () => {
      const date = new Date(2025, 1, 15, 12, 0, 0).toISOString()
      expect(formatRelativeTime(date)).toBe('11 months ago')
    })

    it('should return "1 year ago" for exactly 1 year ago', () => {
      const date = new Date(2025, 0, 15, 12, 0, 0).toISOString()
      expect(formatRelativeTime(date)).toBe('1 year ago')
    })

    it('should return "2 years ago" for 2 years ago', () => {
      const date = new Date(2024, 0, 15, 12, 0, 0).toISOString()
      expect(formatRelativeTime(date)).toBe('2 years ago')
    })

    it('should handle edge case at exact boundary of minutes to hours', () => {
      // 60 minutes ago should be 1 hour
      const date = new Date(2026, 0, 15, 11, 0, 0).toISOString()
      expect(formatRelativeTime(date)).toBe('1 hour ago')
    })

    it('should handle edge case at exact boundary of hours to days', () => {
      // 24 hours ago should be 1 day
      const date = new Date(2026, 0, 14, 12, 0, 0).toISOString()
      expect(formatRelativeTime(date)).toBe('1 day ago')
    })
  })
})
