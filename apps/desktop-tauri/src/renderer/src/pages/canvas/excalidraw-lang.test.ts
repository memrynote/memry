import { describe, it, expect } from 'vitest'
import { pickExcalidrawLangCode } from './excalidraw-lang'

// Shape mirrors Excalidraw's `languages` export ({ code, label, ... }).
const AVAILABLE = [
  { code: 'en' },
  { code: 'tr-TR' },
  { code: 'de-DE' },
  { code: 'pt-BR' },
  { code: 'pt-PT' },
  { code: 'zh-CN' },
  { code: 'zh-TW' }
]

describe('pickExcalidrawLangCode', () => {
  it('returns an exact match', () => {
    expect(pickExcalidrawLangCode('en', AVAILABLE, 'en')).toBe('en')
    expect(pickExcalidrawLangCode('zh-CN', AVAILABLE, 'en')).toBe('zh-CN')
  })

  it('matches case-insensitively', () => {
    expect(pickExcalidrawLangCode('ZH-cn', AVAILABLE, 'en')).toBe('zh-CN')
  })

  it('maps a bare Memry locale to its region-qualified Excalidraw code', () => {
    expect(pickExcalidrawLangCode('tr', AVAILABLE, 'en')).toBe('tr-TR')
    expect(pickExcalidrawLangCode('de', AVAILABLE, 'en')).toBe('de-DE')
  })

  it('falls back to the base language for a region Excalidraw lacks', () => {
    expect(pickExcalidrawLangCode('en-US', AVAILABLE, 'en')).toBe('en')
    // No de-AT — first de-* wins.
    expect(pickExcalidrawLangCode('de-AT', AVAILABLE, 'en')).toBe('de-DE')
  })

  it('picks the first regional variant for an ambiguous base locale', () => {
    expect(pickExcalidrawLangCode('pt', AVAILABLE, 'en')).toBe('pt-BR')
  })

  it('falls back when the locale is unknown or missing', () => {
    expect(pickExcalidrawLangCode('eo', AVAILABLE, 'en')).toBe('en')
    expect(pickExcalidrawLangCode(undefined, AVAILABLE, 'en')).toBe('en')
    expect(pickExcalidrawLangCode('', AVAILABLE, 'en')).toBe('en')
  })
})
