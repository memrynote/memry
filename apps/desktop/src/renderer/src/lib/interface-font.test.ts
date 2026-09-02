import { describe, expect, it } from 'vitest'
import {
  fontChoiceFromSettings,
  fontChoiceKey,
  fontChoiceToSettings,
  isFontInstalled,
  parseFontChoiceKey,
  sanitizeFontFamilyName,
  type FontChoice
} from './interface-font'

describe('sanitizeFontFamilyName', () => {
  it('#given a real font name #when sanitized #then it survives unchanged', () => {
    expect(sanitizeFontFamilyName('Iosevka Term')).toBe('Iosevka Term')
    expect(sanitizeFontFamilyName('SF Pro-Text_2.0')).toBe('SF Pro-Text_2.0')
  })

  it('#given quotes and separators #when sanitized #then they are stripped', () => {
    expect(sanitizeFontFamilyName('"Inter", monospace; color: red')).toBe(
      'Inter monospace color red'
    )
  })

  it('#given padding and repeated spaces #when sanitized #then whitespace collapses', () => {
    expect(sanitizeFontFamilyName('  Noto   Sans  ')).toBe('Noto Sans')
  })

  it('#given an over-long name #when sanitized #then it is capped at 64 characters', () => {
    expect(sanitizeFontFamilyName('a'.repeat(200))).toHaveLength(64)
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

describe('fontChoiceKey', () => {
  it('#given each kind #when keyed #then the kind prefixes the family', () => {
    expect(fontChoiceKey({ kind: 'builtin', family: 'serif' })).toBe('builtin:serif')
    expect(fontChoiceKey({ kind: 'system', family: 'Iosevka Term' })).toBe('system:Iosevka Term')
  })

  it('#given a system family named like a preset #when keyed #then the keys differ', () => {
    expect(fontChoiceKey({ kind: 'system', family: 'inter' })).not.toBe(
      fontChoiceKey({ kind: 'builtin', family: 'inter' })
    )
  })
})

describe('parseFontChoiceKey', () => {
  it('#given a valid key #when parsed #then it round-trips the choice', () => {
    expect(parseFontChoiceKey('builtin:monospace')).toEqual({
      kind: 'builtin',
      family: 'monospace'
    })
    expect(parseFontChoiceKey('system:Iosevka Term')).toEqual({
      kind: 'system',
      family: 'Iosevka Term'
    })
  })

  it('#given a system family named like a preset #when parsed #then it stays a system choice', () => {
    expect(parseFontChoiceKey('system:inter')).toEqual({ kind: 'system', family: 'inter' })
  })

  it('#given an unknown builtin id #when parsed #then it is rejected', () => {
    expect(parseFontChoiceKey('builtin:comic')).toBeNull()
  })

  it('#given a system family with CSS syntax #when parsed #then it is sanitized', () => {
    expect(parseFontChoiceKey('system:"Inter", monospace; color: red')).toEqual({
      kind: 'system',
      family: 'Inter monospace color red'
    })
  })

  it('#given a system family that sanitizes to nothing #when parsed #then it is rejected', () => {
    expect(parseFontChoiceKey('system:;;;')).toBeNull()
    expect(parseFontChoiceKey('system:')).toBeNull()
  })

  it('#given a key with no known kind #when parsed #then it is rejected', () => {
    expect(parseFontChoiceKey('Iosevka Term')).toBeNull()
    expect(parseFontChoiceKey('')).toBeNull()
  })
})

describe('fontChoiceFromSettings', () => {
  it('#given only a preset #when read #then it is a builtin choice', () => {
    expect(fontChoiceFromSettings('serif', '')).toEqual({ kind: 'builtin', family: 'serif' })
    expect(fontChoiceFromSettings('serif', undefined)).toEqual({ kind: 'builtin', family: 'serif' })
  })

  it('#given an unknown preset #when read #then it falls back to system', () => {
    expect(fontChoiceFromSettings('comic', '')).toEqual({ kind: 'builtin', family: 'system' })
  })

  it('#given a custom family alongside a preset #when read #then the custom family wins', () => {
    expect(fontChoiceFromSettings('serif', 'Iosevka Term')).toEqual({
      kind: 'system',
      family: 'Iosevka Term'
    })
  })

  it('#given a custom family that sanitizes to nothing #when read #then the preset wins', () => {
    expect(fontChoiceFromSettings('serif', '  ;;  ')).toEqual({ kind: 'builtin', family: 'serif' })
  })
})

describe('fontChoiceToSettings', () => {
  it('#given a builtin choice #when written #then it clears the custom family', () => {
    expect(fontChoiceToSettings({ kind: 'builtin', family: 'monospace' })).toEqual({
      fontFamily: 'monospace',
      customFontFamily: ''
    })
  })

  it('#given a system choice #when written #then fontFamily is left untouched', () => {
    const update = fontChoiceToSettings({ kind: 'system', family: 'Iosevka Term' })
    expect(update).toEqual({ customFontFamily: 'Iosevka Term' })
    expect('fontFamily' in update).toBe(false)
  })

  it('#given any choice #when written and read back #then it round-trips', () => {
    const choices: FontChoice[] = [
      { kind: 'builtin', family: 'system' },
      { kind: 'builtin', family: 'gelasio' },
      { kind: 'system', family: 'Iosevka Term' }
    ]
    for (const choice of choices) {
      const saved = { fontFamily: 'serif', ...fontChoiceToSettings(choice) }
      expect(fontChoiceFromSettings(saved.fontFamily, saved.customFontFamily)).toEqual(choice)
    }
  })
})
