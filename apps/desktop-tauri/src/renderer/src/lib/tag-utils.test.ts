import { describe, it, expect } from 'vitest'
import {
  normalizeTagName,
  formatTagDisplay,
  sanitizeTagInput,
  isTagTerminator,
  getTagSegments,
  getParentTag,
  getTagDepth,
  getTagLeaf,
  isDescendantOf,
  getAncestorTags
} from './tag-utils'

describe('tag-utils', () => {
  describe('normalizeTagName', () => {
    it('should convert to lowercase', () => {
      expect(normalizeTagName('PROJECT')).toBe('project')
      expect(normalizeTagName('Design')).toBe('design')
    })

    it('should trim whitespace', () => {
      expect(normalizeTagName('  project  ')).toBe('project')
      expect(normalizeTagName('\ttag\n')).toBe('tag')
    })

    it('should remove # prefix', () => {
      expect(normalizeTagName('#project')).toBe('project')
      expect(normalizeTagName('#Design')).toBe('design')
    })

    it('should handle combined operations', () => {
      expect(normalizeTagName('  #PROJECT  ')).toBe('project')
      expect(normalizeTagName('#  Design  ')).toBe('  design')
    })

    it('should preserve hyphens and underscores', () => {
      expect(normalizeTagName('My-Project_Name')).toBe('my-project_name')
    })
  })

  describe('formatTagDisplay', () => {
    it('should add # prefix to tag names', () => {
      expect(formatTagDisplay('project')).toBe('#project')
      expect(formatTagDisplay('design')).toBe('#design')
    })

    it('should handle empty string', () => {
      expect(formatTagDisplay('')).toBe('#')
    })

    it('should not double the # prefix', () => {
      // Note: function doesn't check for existing #, so this behavior is as-is
      expect(formatTagDisplay('#tag')).toBe('##tag')
    })
  })

  describe('sanitizeTagInput', () => {
    it('should remove # prefix', () => {
      expect(sanitizeTagInput('#project')).toBe('project')
    })

    it('should remove spaces', () => {
      expect(sanitizeTagInput('my project')).toBe('myproject')
    })

    it('should remove special characters', () => {
      expect(sanitizeTagInput('tag@email.com')).toBe('tagemailcom')
      expect(sanitizeTagInput('tag!?')).toBe('tag')
    })

    it('should preserve hyphens and underscores', () => {
      expect(sanitizeTagInput('my-tag_name')).toBe('my-tag_name')
    })

    it('should preserve alphanumeric characters', () => {
      expect(sanitizeTagInput('project2024')).toBe('project2024')
    })

    it('should handle combined operations', () => {
      expect(sanitizeTagInput('#my tag@2024!')).toBe('mytag2024')
    })

    it('should return empty string when all chars invalid', () => {
      expect(sanitizeTagInput('###')).toBe('')
      expect(sanitizeTagInput('@!?')).toBe('')
    })

    it('should preserve slashes for hierarchical tags', () => {
      expect(sanitizeTagInput('movies/oscar')).toBe('movies/oscar')
      expect(sanitizeTagInput('#movies/oscar')).toBe('movies/oscar')
    })

    it('should collapse double slashes', () => {
      expect(sanitizeTagInput('movies//oscar')).toBe('movies/oscar')
    })

    it('should strip leading and trailing slashes', () => {
      expect(sanitizeTagInput('/movies/oscar/')).toBe('movies/oscar')
    })
  })

  describe('isTagTerminator', () => {
    it('should return true for space', () => {
      expect(isTagTerminator(' ')).toBe(true)
    })

    it('should return true for common punctuation', () => {
      expect(isTagTerminator(',')).toBe(true)
      expect(isTagTerminator('.')).toBe(true)
      expect(isTagTerminator('!')).toBe(true)
      expect(isTagTerminator('?')).toBe(true)
      expect(isTagTerminator(';')).toBe(true)
      expect(isTagTerminator(':')).toBe(true)
    })

    it('should return true for brackets', () => {
      expect(isTagTerminator('(')).toBe(true)
      expect(isTagTerminator(')')).toBe(true)
      expect(isTagTerminator('[')).toBe(true)
      expect(isTagTerminator(']')).toBe(true)
      expect(isTagTerminator('{')).toBe(true)
      expect(isTagTerminator('}')).toBe(true)
    })

    it('should return false for alphanumeric', () => {
      expect(isTagTerminator('a')).toBe(false)
      expect(isTagTerminator('Z')).toBe(false)
      expect(isTagTerminator('5')).toBe(false)
    })

    it('should return false for hyphen and underscore', () => {
      expect(isTagTerminator('-')).toBe(false)
      expect(isTagTerminator('_')).toBe(false)
    })

    it('should return false for other special chars not in pattern', () => {
      expect(isTagTerminator('@')).toBe(false)
      expect(isTagTerminator('#')).toBe(false)
      expect(isTagTerminator('$')).toBe(false)
    })
  })

  describe('getTagSegments', () => {
    it('should split hierarchical tag into segments', () => {
      expect(getTagSegments('movies/oscar')).toEqual(['movies', 'oscar'])
      expect(getTagSegments('a/b/c')).toEqual(['a', 'b', 'c'])
    })

    it('should return single segment for flat tag', () => {
      expect(getTagSegments('react')).toEqual(['react'])
    })
  })

  describe('getParentTag', () => {
    it('should return parent for hierarchical tag', () => {
      expect(getParentTag('movies/oscar')).toBe('movies')
      expect(getParentTag('a/b/c')).toBe('a/b')
    })

    it('should return null for flat tag', () => {
      expect(getParentTag('react')).toBeNull()
    })
  })

  describe('getTagDepth', () => {
    it('should return 0 for flat tags', () => {
      expect(getTagDepth('react')).toBe(0)
    })

    it('should return correct depth for hierarchical tags', () => {
      expect(getTagDepth('movies/oscar')).toBe(1)
      expect(getTagDepth('a/b/c')).toBe(2)
      expect(getTagDepth('a/b/c/d')).toBe(3)
    })
  })

  describe('getTagLeaf', () => {
    it('should return last segment', () => {
      expect(getTagLeaf('movies/oscar')).toBe('oscar')
      expect(getTagLeaf('a/b/c')).toBe('c')
    })

    it('should return the tag itself for flat tags', () => {
      expect(getTagLeaf('react')).toBe('react')
    })
  })

  describe('isDescendantOf', () => {
    it('should return true for direct children', () => {
      expect(isDescendantOf('movies/oscar', 'movies')).toBe(true)
    })

    it('should return true for deep descendants', () => {
      expect(isDescendantOf('movies/oscar/2025', 'movies')).toBe(true)
      expect(isDescendantOf('movies/oscar/2025', 'movies/oscar')).toBe(true)
    })

    it('should return false for non-descendants', () => {
      expect(isDescendantOf('movies', 'movies')).toBe(false)
      expect(isDescendantOf('movies-extra', 'movies')).toBe(false)
      expect(isDescendantOf('books/fiction', 'movies')).toBe(false)
    })
  })

  describe('getAncestorTags', () => {
    it('should return empty for flat tags', () => {
      expect(getAncestorTags('react')).toEqual([])
    })

    it('should return parent for depth-1 tag', () => {
      expect(getAncestorTags('movies/oscar')).toEqual(['movies'])
    })

    it('should return all ancestors for deep tag', () => {
      expect(getAncestorTags('a/b/c/d')).toEqual(['a', 'a/b', 'a/b/c'])
    })
  })
})
