import { describe, it, expect } from 'vitest'
import {
  matchHashTagImmediate,
  isTagChar,
  extendTagName,
  shrinkTagName
} from './hash-tag-inline-plugin'

describe('hash-tag-inline-plugin', () => {
  describe('matchHashTagImmediate', () => {
    it('matches # followed by a single letter at end of text', () => {
      expect(matchHashTagImmediate('#a')).toBe('a')
    })

    it('matches at start of text', () => {
      expect(matchHashTagImmediate('#z')).toBe('z')
    })

    it('matches after whitespace', () => {
      expect(matchHashTagImmediate('hello #b')).toBe('b')
    })

    it('matches after object replacement char', () => {
      expect(matchHashTagImmediate('\ufffc#c')).toBe('c')
    })

    it('returns null when no hash', () => {
      expect(matchHashTagImmediate('abc')).toBeNull()
    })

    it('returns null for hash only (no letter)', () => {
      expect(matchHashTagImmediate('#')).toBeNull()
    })

    it('returns null for hash with digit', () => {
      expect(matchHashTagImmediate('#1')).toBeNull()
    })

    it('returns null when hash not preceded by whitespace or start', () => {
      expect(matchHashTagImmediate('word#a')).toBeNull()
    })

    it('returns null for multi-char tag (already a word)', () => {
      expect(matchHashTagImmediate('#abc')).toBeNull()
    })

    it('normalizes to lowercase', () => {
      expect(matchHashTagImmediate('#A')).toBe('a')
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
})
