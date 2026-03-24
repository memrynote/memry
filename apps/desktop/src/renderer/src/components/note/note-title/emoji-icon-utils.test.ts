import { describe, it, expect } from 'vitest'
import { isIconValue, parseIconName, toIconValue, ICON_PREFIX } from './emoji-icon-utils'

describe('emoji-icon-utils', () => {
  describe('isIconValue', () => {
    it('returns true for icon-prefixed values', () => {
      expect(isIconValue('icon:Folder01Icon')).toBe(true)
      expect(isIconValue('icon:StarIcon')).toBe(true)
    })

    it('returns false for native emoji', () => {
      expect(isIconValue('😀')).toBe(false)
      expect(isIconValue('📝')).toBe(false)
    })

    it('returns false for null/undefined', () => {
      expect(isIconValue(null)).toBe(false)
      expect(isIconValue(undefined)).toBe(false)
    })

    it('returns false for empty string', () => {
      expect(isIconValue('')).toBe(false)
    })

    it('returns false for partial prefix', () => {
      expect(isIconValue('ico')).toBe(false)
      expect(isIconValue('icon')).toBe(false)
    })
  })

  describe('parseIconName', () => {
    it('strips the icon: prefix', () => {
      expect(parseIconName('icon:Folder01Icon')).toBe('Folder01Icon')
      expect(parseIconName('icon:StarIcon')).toBe('StarIcon')
    })

    it('handles edge case of prefix-only', () => {
      expect(parseIconName('icon:')).toBe('')
    })
  })

  describe('toIconValue', () => {
    it('adds the icon: prefix', () => {
      expect(toIconValue('Folder01Icon')).toBe('icon:Folder01Icon')
      expect(toIconValue('StarIcon')).toBe('icon:StarIcon')
    })
  })

  describe('ICON_PREFIX', () => {
    it('is "icon:"', () => {
      expect(ICON_PREFIX).toBe('icon:')
    })
  })

  describe('roundtrip', () => {
    it('toIconValue → isIconValue → parseIconName', () => {
      const iconName = 'Camera01Icon'
      const stored = toIconValue(iconName)
      expect(isIconValue(stored)).toBe(true)
      expect(parseIconName(stored)).toBe(iconName)
    })
  })
})
