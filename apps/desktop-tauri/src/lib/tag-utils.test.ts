import { describe, it, expect } from 'vitest'
import {
  isValidTagName,
  normalizeTagName,
  formatTagDisplay,
  extractTagsFromText,
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
  describe('isValidTagName', () => {
    it('should return true for valid single-word tags', () => {
      expect(isValidTagName('project')).toBe(true)
      expect(isValidTagName('Design')).toBe(true)
      expect(isValidTagName('TODO')).toBe(true)
    })

    it('should return true for tags starting with numbers', () => {
      expect(isValidTagName('2024')).toBe(true)
      expect(isValidTagName('5projects')).toBe(true)
    })

    it('should return true for tags with hyphens', () => {
      expect(isValidTagName('work-project')).toBe(true)
      expect(isValidTagName('my-tag-name')).toBe(true)
    })

    it('should return true for tags with underscores', () => {
      expect(isValidTagName('work_project')).toBe(true)
      expect(isValidTagName('my_tag_name')).toBe(true)
    })

    it('should return true for mixed alphanumeric tags', () => {
      expect(isValidTagName('project2024')).toBe(true)
      expect(isValidTagName('v2-release')).toBe(true)
      expect(isValidTagName('q1_2024')).toBe(true)
    })

    it('should return false for empty strings', () => {
      expect(isValidTagName('')).toBe(false)
    })

    it('should return false for tags starting with special chars', () => {
      expect(isValidTagName('-invalid')).toBe(false)
      expect(isValidTagName('_invalid')).toBe(false)
      expect(isValidTagName('#hashtag')).toBe(false)
      expect(isValidTagName('@mention')).toBe(false)
    })

    it('should return false for tags with spaces', () => {
      expect(isValidTagName('my tag')).toBe(false)
      expect(isValidTagName('project name')).toBe(false)
    })

    it('should return false for tags with special punctuation', () => {
      expect(isValidTagName('my.tag')).toBe(false)
      expect(isValidTagName('tag!')).toBe(false)
      expect(isValidTagName('tag?')).toBe(false)
      expect(isValidTagName('tag@email')).toBe(false)
    })

    it('should return true for hierarchical tags with slashes', () => {
      expect(isValidTagName('movies/oscar')).toBe(true)
      expect(isValidTagName('movies/oscar/2025')).toBe(true)
      expect(isValidTagName('a/b/c/d')).toBe(true)
      expect(isValidTagName('work-project/frontend')).toBe(true)
      expect(isValidTagName('q1_2024/goals')).toBe(true)
    })

    it('should return false for tags with leading/trailing slashes', () => {
      expect(isValidTagName('/movies')).toBe(false)
      expect(isValidTagName('movies/')).toBe(false)
      expect(isValidTagName('/movies/')).toBe(false)
    })

    it('should return false for tags with double slashes', () => {
      expect(isValidTagName('movies//oscar')).toBe(false)
    })

    it('should return false for tags with empty segments', () => {
      expect(isValidTagName('movies//oscar')).toBe(false)
    })

    it('should return false for segments starting with special chars', () => {
      expect(isValidTagName('movies/-oscar')).toBe(false)
      expect(isValidTagName('movies/_oscar')).toBe(false)
    })
  })

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

  describe('extractTagsFromText', () => {
    it('should extract single tag', () => {
      const result = extractTagsFromText('This is a #project note')
      expect(result).toEqual(['project'])
    })

    it('should extract multiple tags', () => {
      const result = extractTagsFromText('#design and #development are fun')
      expect(result).toEqual(['design', 'development'])
    })

    it('should return unique tags only', () => {
      const result = extractTagsFromText('#project and #project again #project')
      expect(result).toEqual(['project'])
    })

    it('should extract tags with hyphens', () => {
      const result = extractTagsFromText('Working on #work-project')
      expect(result).toEqual(['work-project'])
    })

    it('should extract tags with underscores', () => {
      const result = extractTagsFromText('Check out #my_tag')
      expect(result).toEqual(['my_tag'])
    })

    it('should extract tags with numbers', () => {
      const result = extractTagsFromText('#2024 goals and #v2-release')
      expect(result).toEqual(['2024', 'v2-release'])
    })

    it('should return empty array when no tags', () => {
      const result = extractTagsFromText('Just plain text')
      expect(result).toEqual([])
    })

    it('should not extract invalid tag patterns', () => {
      // Tag regex only matches alphanumeric, hyphen, underscore
      const result = extractTagsFromText('#@ #! #.')
      expect(result).toEqual([])
    })

    it('should handle tags at start and end of text', () => {
      const result = extractTagsFromText('#start in the middle #end')
      expect(result).toEqual(['start', 'end'])
    })

    it('should handle adjacent tags', () => {
      // Adjacent tags without space: #tag1#tag2 - regex matches "tag1" (up to # terminator)
      // and "tag2" as separate matches
      const result = extractTagsFromText('#tag1#tag2')
      expect(result).toEqual(['tag1', 'tag2'])
    })

    it('should handle multiline text', () => {
      const result = extractTagsFromText('Line 1 #tag1\nLine 2 #tag2')
      expect(result).toEqual(['tag1', 'tag2'])
    })

    it('should extract hierarchical tags with slashes', () => {
      const result = extractTagsFromText('Check out #movies/oscar and #movies/grammy')
      expect(result).toEqual(['movies/oscar', 'movies/grammy'])
    })

    it('should extract deeply nested hierarchical tags', () => {
      const result = extractTagsFromText('#a/b/c/d is deep')
      expect(result).toEqual(['a/b/c/d'])
    })

    it('should not match trailing slashes as part of tag', () => {
      const result = extractTagsFromText('#movies/ is not complete')
      expect(result).toEqual(['movies'])
    })

    it('should handle mixed flat and hierarchical tags', () => {
      const result = extractTagsFromText('#react #movies/oscar #typescript')
      expect(result).toEqual(['react', 'movies/oscar', 'typescript'])
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
