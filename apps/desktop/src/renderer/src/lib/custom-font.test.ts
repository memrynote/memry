import { describe, expect, it } from 'vitest'
import { isFontInstalled, sanitizeCustomFontName } from './custom-font'

describe('sanitizeCustomFontName', () => {
  it('#given a real font name #when sanitized #then it survives unchanged', () => {
    expect(sanitizeCustomFontName('Iosevka Term')).toBe('Iosevka Term')
    expect(sanitizeCustomFontName('SF Pro-Text_2.0')).toBe('SF Pro-Text_2.0')
  })

  it('#given quotes and separators #when sanitized #then they are stripped', () => {
    expect(sanitizeCustomFontName('"Inter", monospace; color: red')).toBe(
      'Inter monospace color red'
    )
  })

  it('#given padding and repeated spaces #when sanitized #then whitespace collapses', () => {
    expect(sanitizeCustomFontName('  Noto   Sans  ')).toBe('Noto Sans')
  })

  it('#given an over-long name #when sanitized #then it is capped at 64 characters', () => {
    expect(sanitizeCustomFontName('a'.repeat(200))).toHaveLength(64)
  })
})

describe('isFontInstalled', () => {
  it('#given an empty name #when checked #then it reports not installed', () => {
    expect(isFontInstalled('   ')).toBe(false)
  })

  it('#given no usable document.fonts.check #when checked #then it assumes installed', () => {
    expect(isFontInstalled('Some Font')).toBe(true)
  })
})
