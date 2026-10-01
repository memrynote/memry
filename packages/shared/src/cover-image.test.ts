import { describe, expect, it } from 'vitest'
import {
  COVER_WASHES,
  DEFAULT_COVER_FRAMING,
  clampCoverFocus,
  clampCoverHeight,
  clampCoverZoom,
  coverWashForSeed,
  coverWashGradient,
  coverWashRef,
  isCoverCreditUrlValue,
  isCoverCreditValue,
  isCoverFocusValue,
  isCoverHeightValue,
  isCoverValue,
  isCoverZoomValue,
  parseCoverFocus,
  parseCoverFraming,
  parseCoverValue
} from './cover-image'

describe('parseCoverValue', () => {
  it('reads a known wash id', () => {
    expect(parseCoverValue('wash:sage')).toEqual({ kind: 'wash', id: 'sage' })
    expect(parseCoverValue('wash:plum')).toEqual({ kind: 'wash', id: 'plum' })
  })

  it('rejects an unknown wash id rather than falling back to an image ref', () => {
    // `wash:whatever` is not a filename either, so treating it as an image
    // would paint a broken picture over a value we do not own.
    expect(parseCoverValue('wash:chartreuse')).toBeNull()
    expect(parseCoverValue('wash:')).toBeNull()
    expect(parseCoverValue('wash:SAGE')).toBeNull()
  })

  it('reads http(s) URLs whatever the case of the scheme', () => {
    expect(parseCoverValue('https://example.com/x')).toEqual({
      kind: 'image',
      ref: 'https://example.com/x'
    })
    expect(parseCoverValue('HTTP://EXAMPLE.COM/x')).toEqual({
      kind: 'image',
      ref: 'HTTP://EXAMPLE.COM/x'
    })
  })

  it('reads an image path, including a query string or fragment after it', () => {
    expect(parseCoverValue('../attachments/n1/a.JPG')?.kind).toBe('image')
    expect(parseCoverValue('a.png?v=2')?.kind).toBe('image')
    expect(parseCoverValue('a.webp#frag')?.kind).toBe('image')
    expect(parseCoverValue('x.avif')?.kind).toBe('image')
  })

  it('rejects prose, non-image paths, emptiness and non-strings', () => {
    for (const value of ['', 'Hardback', 'notes/readme.md', 'https', null, undefined, 42, {}]) {
      expect(parseCoverValue(value)).toBeNull()
    }
  })

  it('agrees with isCoverValue on every case', () => {
    for (const value of ['wash:sage', 'a.png', 'Hardback', '', null, 42]) {
      expect(isCoverValue(value)).toBe(parseCoverValue(value) !== null)
    }
  })

  it('round-trips every wash through coverWashRef', () => {
    for (const wash of COVER_WASHES) {
      expect(parseCoverValue(coverWashRef(wash.id))).toEqual({ kind: 'wash', id: wash.id })
    }
  })
})

describe('COVER_WASHES', () => {
  it('holds twelve washes with unique ids', () => {
    expect(COVER_WASHES).toHaveLength(12)
    expect(new Set(COVER_WASHES.map((wash) => wash.id)).size).toBe(12)
  })

  it('renders a diagonal gradient from the pair', () => {
    expect(coverWashGradient('sage')).toBe('linear-gradient(135deg, #dfe7e3 0%, #b9ccc4 100%)')
  })

  it('derives a stable wash from a seed', () => {
    expect(coverWashForSeed('nte_9f2c1a')).toBe(coverWashForSeed('nte_9f2c1a'))
    expect(COVER_WASHES.some((wash) => wash.id === coverWashForSeed(''))).toBe(true)
  })
})

describe('clampCoverFocus', () => {
  it('holds the value inside 0..100', () => {
    expect(clampCoverFocus(-40)).toBe(0)
    expect(clampCoverFocus(0)).toBe(0)
    expect(clampCoverFocus(37.4)).toBe(37)
    expect(clampCoverFocus(100)).toBe(100)
    expect(clampCoverFocus(1000)).toBe(100)
  })

  it('falls back to the centre for values that are not numbers at all', () => {
    expect(clampCoverFocus(Number.NaN)).toBe(50)
    expect(clampCoverFocus(Number.POSITIVE_INFINITY)).toBe(50)
  })

  it('reads frontmatter through the same clamp', () => {
    expect(parseCoverFocus(12)).toBe(12)
    expect(parseCoverFocus('12')).toBe(50)
    expect(parseCoverFocus(undefined)).toBe(50)
    expect(parseCoverFocus(140)).toBe(50)
  })
})

describe('cover key value gates', () => {
  it('accepts only a real 0..100 number as coverFocus', () => {
    expect(isCoverFocusValue(0)).toBe(true)
    expect(isCoverFocusValue(100)).toBe(true)
    expect(isCoverFocusValue(-1)).toBe(false)
    expect(isCoverFocusValue(101)).toBe(false)
    expect(isCoverFocusValue('50')).toBe(false)
    expect(isCoverFocusValue(Number.NaN)).toBe(false)
    expect(isCoverFocusValue(null)).toBe(false)
  })

  it('accepts only a non-empty string as coverCredit', () => {
    expect(isCoverCreditValue('Ana Ruiz')).toBe(true)
    expect(isCoverCreditValue('   ')).toBe(false)
    expect(isCoverCreditValue('')).toBe(false)
    expect(isCoverCreditValue(7)).toBe(false)
  })

  it('accepts only an http(s) URL as coverCreditUrl', () => {
    expect(isCoverCreditUrlValue('https://unsplash.com/@ana')).toBe(true)
    expect(isCoverCreditUrlValue('HTTP://unsplash.com/@ana')).toBe(true)
    expect(isCoverCreditUrlValue('unsplash.com/@ana')).toBe(false)
    expect(isCoverCreditUrlValue('javascript:alert(1)')).toBe(false)
    expect(isCoverCreditUrlValue(null)).toBe(false)
  })
})

describe('cover zoom and height', () => {
  it('clamps zoom onto 1..3 at two decimals', () => {
    expect(clampCoverZoom(0.4)).toBe(1)
    expect(clampCoverZoom(1.1 + 0.1)).toBe(1.2)
    expect(clampCoverZoom(1.456)).toBe(1.46)
    expect(clampCoverZoom(9)).toBe(3)
    expect(clampCoverZoom(Number.NaN)).toBe(1)
  })

  it('clamps height onto 120..480 whole pixels', () => {
    expect(clampCoverHeight(40)).toBe(120)
    expect(clampCoverHeight(260.6)).toBe(261)
    expect(clampCoverHeight(2000)).toBe(480)
    expect(clampCoverHeight(Number.NaN)).toBe(200)
  })

  it('gates coverZoom and coverHeight on an in-range number', () => {
    expect(isCoverZoomValue(1)).toBe(true)
    expect(isCoverZoomValue(3)).toBe(true)
    expect(isCoverZoomValue(0.5)).toBe(false)
    expect(isCoverZoomValue('2x')).toBe(false)
    expect(isCoverHeightValue(120)).toBe(true)
    expect(isCoverHeightValue(480)).toBe(true)
    expect(isCoverHeightValue(600)).toBe(false)
    expect(isCoverHeightValue('tall')).toBe(false)
  })
})

describe('parseCoverFraming', () => {
  it('reads a note without any framing key as the framing every cover had before', () => {
    expect(parseCoverFraming({})).toEqual({ focusX: 50, focusY: 50, zoom: 1, height: 200 })
    expect(parseCoverFraming({ coverFocus: 30 })).toEqual({ ...DEFAULT_COVER_FRAMING, focusY: 30 })
  })

  it('reads every framing key', () => {
    expect(
      parseCoverFraming({ coverFocus: 30, coverFocusX: 70, coverZoom: 1.5, coverHeight: 320 })
    ).toEqual({ focusX: 70, focusY: 30, zoom: 1.5, height: 320 })
  })

  it('falls back per key for values that are not framing', () => {
    expect(parseCoverFraming({ coverFocusX: 'left', coverZoom: 7, coverHeight: 'tall' })).toEqual(
      DEFAULT_COVER_FRAMING
    )
  })
})
