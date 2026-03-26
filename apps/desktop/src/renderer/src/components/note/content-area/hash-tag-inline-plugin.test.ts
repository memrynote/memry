import { describe, it, expect } from 'vitest'
import {
  matchHashTagWithSpace,
  matchTrailingTagChars,
  isTagChar,
  extendTagName,
  shrinkTagName
} from './hash-tag-inline-plugin'

describe('hash-tag-inline-plugin', () => {
  describe('matchHashTagWithSpace', () => {
    it('matches #tag followed by space at end of text', () => {
      expect(matchHashTagWithSpace('#abc ')).toBe('abc')
    })

    it('matches single-letter tag', () => {
      expect(matchHashTagWithSpace('#a ')).toBe('a')
    })

    it('matches after whitespace', () => {
      expect(matchHashTagWithSpace('hello #test ')).toBe('test')
    })

    it('matches after object replacement char', () => {
      expect(matchHashTagWithSpace('\ufffc#car ')).toBe('car')
    })

    it('matches tags with digits', () => {
      expect(matchHashTagWithSpace('#v2 ')).toBe('v2')
    })

    it('matches tags with hyphens and underscores', () => {
      expect(matchHashTagWithSpace('#my-tag_v2 ')).toBe('my-tag_v2')
    })

    it('returns null without trailing space', () => {
      expect(matchHashTagWithSpace('#abc')).toBeNull()
    })

    it('returns null for hash only', () => {
      expect(matchHashTagWithSpace('# ')).toBeNull()
    })

    it('returns null for hash with digit start', () => {
      expect(matchHashTagWithSpace('#1abc ')).toBeNull()
    })

    it('returns null when hash not preceded by whitespace or start', () => {
      expect(matchHashTagWithSpace('word#abc ')).toBeNull()
    })

    it('normalizes to lowercase', () => {
      expect(matchHashTagWithSpace('#Japan ')).toBe('japan')
    })

    it('matches at start of text', () => {
      expect(matchHashTagWithSpace('#design ')).toBe('design')
    })
  })

  describe('isTagChar', () => {
    it('accepts lowercase letters', () => {
      expect(isTagChar('a')).toBe(true)
      expect(isTagChar('z')).toBe(true)
    })

    it('accepts uppercase letters', () => {
      expect(isTagChar('A')).toBe(true)
      expect(isTagChar('Z')).toBe(true)
    })

    it('accepts digits', () => {
      expect(isTagChar('0')).toBe(true)
      expect(isTagChar('9')).toBe(true)
    })

    it('accepts hyphen and underscore', () => {
      expect(isTagChar('-')).toBe(true)
      expect(isTagChar('_')).toBe(true)
    })

    it('rejects space', () => {
      expect(isTagChar(' ')).toBe(false)
    })

    it('rejects special characters', () => {
      expect(isTagChar('@')).toBe(false)
      expect(isTagChar('!')).toBe(false)
      expect(isTagChar('#')).toBe(false)
    })

    it('rejects empty string', () => {
      expect(isTagChar('')).toBe(false)
    })
  })

  describe('extendTagName', () => {
    it('appends character to tag name', () => {
      expect(extendTagName('a', 'b')).toBe('ab')
    })

    it('normalizes to lowercase', () => {
      expect(extendTagName('hello', 'W')).toBe('hellow')
    })

    it('appends digits', () => {
      expect(extendTagName('v', '2')).toBe('v2')
    })

    it('appends hyphen', () => {
      expect(extendTagName('my', '-')).toBe('my-')
    })

    it('appends underscore', () => {
      expect(extendTagName('my', '_')).toBe('my_')
    })
  })

  describe('shrinkTagName', () => {
    it('removes last character', () => {
      expect(shrinkTagName('abc')).toBe('ab')
    })

    it('returns single char from two-char tag', () => {
      expect(shrinkTagName('ab')).toBe('a')
    })

    it('returns null for single-char tag (tag should be deleted)', () => {
      expect(shrinkTagName('a')).toBeNull()
    })

    it('returns null for empty string', () => {
      expect(shrinkTagName('')).toBeNull()
    })
  })

  describe('matchTrailingTagChars', () => {
    it('matches tag chars after object replacement char', () => {
      expect(matchTrailingTagChars('\ufffcabc')).toEqual({ chars: 'abc', offset: 0 })
    })

    it('matches after text + object replacement char', () => {
      expect(matchTrailingTagChars('hello \ufffccar')).toEqual({ chars: 'car', offset: 6 })
    })

    it('returns null when no object replacement char', () => {
      expect(matchTrailingTagChars('abc')).toBeNull()
    })

    it('returns null for lone object replacement char (no trailing chars)', () => {
      expect(matchTrailingTagChars('\ufffc')).toBeNull()
    })

    it('returns null when space follows object replacement char', () => {
      expect(matchTrailingTagChars('\ufffc test')).toBeNull()
    })

    it('matches digits in trailing chars', () => {
      expect(matchTrailingTagChars('\ufffcv2')).toEqual({ chars: 'v2', offset: 0 })
    })

    it('matches hyphens and underscores', () => {
      expect(matchTrailingTagChars('\ufffcmy-tag_v2')).toEqual({ chars: 'my-tag_v2', offset: 0 })
    })

    it('only matches the last object replacement char', () => {
      expect(matchTrailingTagChars('\ufffc first \ufffcsecond')).toEqual({
        chars: 'second',
        offset: 8
      })
    })

    it('returns null if chars end with space', () => {
      expect(matchTrailingTagChars('\ufffcabc ')).toBeNull()
    })
  })
})
