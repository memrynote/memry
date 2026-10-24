import { describe, expect, it } from 'vitest'

import {
  FILE_AUDIO_SCROLL_KEY,
  FILE_VIEW_STATE_KEYS,
  parseNullableScale,
  parsePdfPage,
  parsePlaybackPosition,
  parseRotation,
  parseScale,
  parseViewerBoolean,
  parseViewerPosition,
  pdfPageScrollKey,
  shouldResumePlayback
} from './file-view-state'

describe('file view-state keys', () => {
  it('uses a distinct key per persisted value', () => {
    const keys = Object.values(FILE_VIEW_STATE_KEYS)
    expect(new Set(keys).size).toBe(keys.length)
  })

  it('keeps each viewer apart, so a PDF zoom is not an image zoom', () => {
    expect(FILE_VIEW_STATE_KEYS.pdfScale).not.toBe(FILE_VIEW_STATE_KEYS.imageScale)
    expect(FILE_VIEW_STATE_KEYS.pdfRotation).not.toBe(FILE_VIEW_STATE_KEYS.imageRotation)
    expect(FILE_VIEW_STATE_KEYS.audioPosition).not.toBe(FILE_VIEW_STATE_KEYS.videoPosition)
  })

  it('stores nothing about whether the media is playing', () => {
    // Restoring a session must not start making noise.
    for (const key of Object.values(FILE_VIEW_STATE_KEYS)) {
      expect(key.toLowerCase()).not.toContain('playing')
    }
  })
})

describe('pdfPageScrollKey', () => {
  it('gives every page its own scroller identity', () => {
    // The main pane renders ONE page, so an offset only means anything on the
    // page it was measured on. The entity stamp guards the file, not the page.
    expect(pdfPageScrollKey(1)).not.toBe(pdfPageScrollKey(2))
  })

  it('never collides with the audio pane', () => {
    expect(pdfPageScrollKey(1)).not.toBe(FILE_AUDIO_SCROLL_KEY)
  })
})

describe('viewer readers', () => {
  it('accepts only real 1-based page numbers', () => {
    expect(parsePdfPage(1)).toBe(1)
    expect(parsePdfPage(120)).toBe(120)
    expect(parsePdfPage(0)).toBeUndefined()
    expect(parsePdfPage(-3)).toBeUndefined()
    expect(parsePdfPage(1.5)).toBeUndefined()
    expect(parsePdfPage('2')).toBeUndefined()
  })

  it('rejects a zoom that would render nothing', () => {
    expect(parseScale(1.25)).toBe(1.25)
    expect(parseScale(0)).toBeUndefined()
    expect(parseScale(-1)).toBeUndefined()
    expect(parseScale(Number.NaN)).toBeUndefined()
    expect(parseScale(Number.POSITIVE_INFINITY)).toBeUndefined()
  })

  it('keeps `null` zoom, which is "never zoomed" and not "zoomed to nothing"', () => {
    // This is the value fit-to-container is gated on.
    expect(parseNullableScale(null)).toBeNull()
    expect(parseNullableScale(2)).toBe(2)
    expect(parseNullableScale(0)).toBeUndefined()
    expect(parseNullableScale(undefined)).toBeUndefined()
  })

  it('accepts only the four quarter turns the button can produce', () => {
    expect(parseRotation(0)).toBe(0)
    expect(parseRotation(270)).toBe(270)
    expect(parseRotation(45)).toBeUndefined()
    expect(parseRotation(360)).toBeUndefined()
    expect(parseRotation('90')).toBeUndefined()
  })

  it('takes only real booleans for the thumbnail rail', () => {
    expect(parseViewerBoolean(false)).toBe(false)
    expect(parseViewerBoolean('true')).toBeUndefined()
  })

  it('requires both pan coordinates to be real numbers', () => {
    expect(parseViewerPosition({ x: 10, y: -4 })).toEqual({ x: 10, y: -4 })
    expect(parseViewerPosition({ x: 10 })).toBeUndefined()
    expect(parseViewerPosition({ x: 10, y: Number.NaN })).toBeUndefined()
    expect(parseViewerPosition([10, 4])).toBeUndefined()
    expect(parseViewerPosition(null)).toBeUndefined()
  })

  it('accepts a playback position of 0, which is the start of the track', () => {
    expect(parsePlaybackPosition(0)).toBe(0)
    expect(parsePlaybackPosition(93.5)).toBe(93.5)
    expect(parsePlaybackPosition(-1)).toBeUndefined()
    expect(parsePlaybackPosition(Number.NaN)).toBeUndefined()
  })
})

describe('shouldResumePlayback', () => {
  it('seeks to a position with something left to play', () => {
    expect(shouldResumePlayback(90, 300)).toBe(true)
  })

  it('does not seek to the very end a finished track leaves behind', () => {
    // Otherwise reopening the file parks it on the last frame with nothing left.
    expect(shouldResumePlayback(300, 300)).toBe(false)
    expect(shouldResumePlayback(299.5, 300)).toBe(false)
    expect(shouldResumePlayback(400, 300)).toBe(false)
  })

  it('does not seek when the start is where we already are', () => {
    expect(shouldResumePlayback(0, 300)).toBe(false)
  })

  it('does not seek when the duration is unknown or unseekable', () => {
    // A live stream reports Infinity, and metadata that has not loaded reports 0.
    expect(shouldResumePlayback(90, 0)).toBe(false)
    expect(shouldResumePlayback(90, Number.NaN)).toBe(false)
    expect(shouldResumePlayback(90, Number.POSITIVE_INFINITY)).toBe(false)
  })
})
