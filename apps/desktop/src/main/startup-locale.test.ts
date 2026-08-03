import { describe, it, expect } from 'vitest'
import { resolveOsLocale } from './startup-locale'

describe('resolveOsLocale', () => {
  it('passes through a tag that is already a supported locale', () => {
    expect(resolveOsLocale('en')).toBe('en')
    expect(resolveOsLocale('tr')).toBe('tr')
    expect(resolveOsLocale('fil')).toBe('fil')
  })

  it('collapses region variants onto their base language', () => {
    expect(resolveOsLocale('de-AT')).toBe('de')
    expect(resolveOsLocale('pt-BR')).toBe('pt')
    expect(resolveOsLocale('en-GB')).toBe('en')
    expect(resolveOsLocale('fr-CA')).toBe('fr')
  })

  it('maps Simplified Chinese tags onto zh-CN', () => {
    expect(resolveOsLocale('zh-Hans')).toBe('zh-CN')
    expect(resolveOsLocale('zh-CN')).toBe('zh-CN')
    expect(resolveOsLocale('zh-SG')).toBe('zh-CN')
    // CLDR's likely-subtags default for a bare `zh` is Simplified.
    expect(resolveOsLocale('zh')).toBe('zh-CN')
  })

  it('maps the Norwegian tags the OS actually reports onto no', () => {
    // macOS/Windows report Bokmål/Nynorsk as nb/nn — `no` is never emitted.
    expect(resolveOsLocale('nb')).toBe('no')
    expect(resolveOsLocale('nb-NO')).toBe('no')
    expect(resolveOsLocale('nn-NO')).toBe('no')
    expect(resolveOsLocale('no')).toBe('no')
  })

  it('maps Traditional Chinese tags onto zh-TW', () => {
    expect(resolveOsLocale('zh-Hant')).toBe('zh-TW')
    expect(resolveOsLocale('zh-TW')).toBe('zh-TW')
    expect(resolveOsLocale('zh-HK')).toBe('zh-TW')
  })

  it('lets a script subtag win over the bare language', () => {
    // macOS/Windows can hand back a full language-script-region tag.
    expect(resolveOsLocale('zh-Hans-CN')).toBe('zh-CN')
    expect(resolveOsLocale('zh-Hant-TW')).toBe('zh-TW')
  })

  it('ignores case and underscore separators', () => {
    expect(resolveOsLocale('PT_BR')).toBe('pt')
    expect(resolveOsLocale('zh_hant_hk')).toBe('zh-TW')
    expect(resolveOsLocale('  en-US  ')).toBe('en')
  })

  it('falls back to English for unsupported or missing tags', () => {
    expect(resolveOsLocale('xh-ZA')).toBe('en')
    expect(resolveOsLocale('')).toBe('en')
    expect(resolveOsLocale(null)).toBe('en')
    expect(resolveOsLocale(undefined)).toBe('en')
  })
})
