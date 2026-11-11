import { describe, expect, it } from 'vitest'
import {
  LARGE_FILE_SCALED_LINES,
  anchorForScrollTop,
  endAnchor,
  maxAnchorLine,
  scaledSpan,
  scrollTopForLine,
  settle
} from './large-file-scroll'

const LINES = 30_900_000
const VISIBLE = 20
const MAX_SCROLL = scaledSpan(32) - VISIBLE * 32

describe('scaled scroll mapping', () => {
  it('keeps the scrollbar inside the layout limit whatever the line count', () => {
    // WebKit and Chromium stop laying out at about 33.5 million px.
    expect(scaledSpan(32)).toBeLessThan(33_000_000)
    expect(LARGE_FILE_SCALED_LINES * 32).toBe(scaledSpan(32))
  })

  it('puts the first line at the top of the track', () => {
    expect(anchorForScrollTop(0, MAX_SCROLL, LINES, VISIBLE)).toEqual({ line: 0, offset: 0 })
    expect(scrollTopForLine(0, MAX_SCROLL, LINES, VISIBLE)).toBe(0)
  })

  it('maps the middle of the track to the middle of the file', () => {
    const middle = anchorForScrollTop(MAX_SCROLL / 2, MAX_SCROLL, LINES, VISIBLE)
    expect(middle).toEqual({ line: Math.round((LINES - VISIBLE) / 2), offset: 0 })
    expect(scrollTopForLine(middle.line, MAX_SCROLL, LINES, VISIBLE)).toBeCloseTo(MAX_SCROLL / 2, 0)
  })

  it('round-trips a line through the scrollbar to within one px of track', () => {
    for (const line of [1, 12_345, 7_000_000, 30_000_000]) {
      const top = scrollTopForLine(line, MAX_SCROLL, LINES, VISIBLE)
      const back = anchorForScrollTop(top, MAX_SCROLL, LINES, VISIBLE).line
      const linesPerPx = (LINES - VISIBLE) / MAX_SCROLL
      expect(Math.abs(back - line)).toBeLessThanOrEqual(Math.ceil(linesPerPx))
    }
  })

  it('reaches the last line at the bottom of the track', () => {
    const end = anchorForScrollTop(MAX_SCROLL, MAX_SCROLL, LINES, VISIBLE)
    expect(end).toEqual(endAnchor(LINES))
    expect(end.line).toBe(LINES - 1)
    expect(scrollTopForLine(LINES - 1, MAX_SCROLL, LINES, VISIBLE)).toBe(MAX_SCROLL)
    // The last line the track can put at the top still leaves the final line in view.
    expect(maxAnchorLine(LINES, VISIBLE) + VISIBLE - 1).toBe(LINES - 1)
  })

  it('maps a file shorter than a viewport to its first line', () => {
    expect(anchorForScrollTop(10, MAX_SCROLL, 5, VISIBLE)).toEqual({ line: 0, offset: 0 })
    expect(scrollTopForLine(4, MAX_SCROLL, 5, VISIBLE)).toBe(0)
    expect(anchorForScrollTop(0, 0, LINES, VISIBLE)).toEqual({ line: 0, offset: 0 })
  })
})

describe('settle', () => {
  const heights = (line: number): number => (line % 2 === 0 ? 32 : 500)

  it('steps a px distance across rows of different heights', () => {
    expect(settle({ line: 10, offset: 32 + 500 + 5 }, heights, LINES)).toEqual({
      line: 12,
      offset: 5
    })
  })

  it('steps back across rows above the anchor', () => {
    expect(settle({ line: 10, offset: -501 }, heights, LINES)).toEqual({ line: 8, offset: 31 })
  })

  it('stops at the top of the file', () => {
    expect(settle({ line: 1, offset: -10_000 }, heights, LINES)).toEqual({ line: 0, offset: 0 })
  })

  it('stops on the last line rather than walking past it', () => {
    expect(settle({ line: LINES - 2, offset: 10_000 }, heights, LINES).line).toBe(LINES - 1)
  })
})
