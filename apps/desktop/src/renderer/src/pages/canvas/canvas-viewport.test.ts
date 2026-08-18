import { describe, expect, it } from 'vitest'

import {
  parseCanvasViewport,
  sameViewport,
  viewportFromAppState,
  type CanvasViewport
} from './canvas-viewport'

const VIEWPORT: CanvasViewport = { scrollX: -120.5, scrollY: 340, zoom: 1.75 }

describe('parseCanvasViewport', () => {
  it('accepts a well-formed record', () => {
    expect(parseCanvasViewport({ ...VIEWPORT })).toEqual(VIEWPORT)
  })

  it('keeps the origin at 100%, which is a real camera and not "nothing stored"', () => {
    expect(parseCanvasViewport({ scrollX: 0, scrollY: 0, zoom: 1 })).toEqual({
      scrollX: 0,
      scrollY: 0,
      zoom: 1
    })
  })

  it.each([
    ['not an object', 42],
    ['null', null],
    ['an array', []],
    ['a missing axis', { scrollX: 10, zoom: 1 }],
    ['a missing zoom', { scrollX: 10, scrollY: 10 }],
    ['a stringified number', { scrollX: '10', scrollY: 10, zoom: 1 }],
    ['NaN', { scrollX: Number.NaN, scrollY: 10, zoom: 1 }],
    ['Infinity', { scrollX: 10, scrollY: Number.POSITIVE_INFINITY, zoom: 1 }]
  ])('rejects %s', (_label, raw) => {
    expect(parseCanvasViewport(raw)).toBeUndefined()
  })

  it('rejects a zoom outside Excalidraw range rather than clamping it', () => {
    // Clamping would drop the user at a position they never left the canvas at;
    // rejecting falls back to first-open behaviour.
    expect(parseCanvasViewport({ scrollX: 0, scrollY: 0, zoom: 0.05 })).toBeUndefined()
    expect(parseCanvasViewport({ scrollX: 0, scrollY: 0, zoom: 42 })).toBeUndefined()
    expect(parseCanvasViewport({ scrollX: 0, scrollY: 0, zoom: -1 })).toBeUndefined()
  })

  it('accepts the range boundaries themselves', () => {
    expect(parseCanvasViewport({ scrollX: 0, scrollY: 0, zoom: 0.1 })?.zoom).toBe(0.1)
    expect(parseCanvasViewport({ scrollX: 0, scrollY: 0, zoom: 30 })?.zoom).toBe(30)
  })

  it('drops keys it does not know', () => {
    expect(parseCanvasViewport({ ...VIEWPORT, theme: 'dark' })).toEqual(VIEWPORT)
  })
})

describe('viewportFromAppState', () => {
  it('unwraps the zoom Excalidraw nests', () => {
    expect(viewportFromAppState({ scrollX: -120.5, scrollY: 340, zoom: { value: 1.75 } })).toEqual(
      VIEWPORT
    )
  })

  it('reads nothing out of a pre-init appState', () => {
    // Excalidraw hands out an appState before initialData is applied; there is
    // no camera in it worth recording.
    expect(viewportFromAppState({})).toBeUndefined()
  })
})

describe('sameViewport', () => {
  it('compares all three axes', () => {
    expect(sameViewport(VIEWPORT, { ...VIEWPORT })).toBe(true)
    expect(sameViewport(VIEWPORT, { ...VIEWPORT, zoom: 1.76 })).toBe(false)
    expect(sameViewport(VIEWPORT, { ...VIEWPORT, scrollX: 0 })).toBe(false)
    expect(sameViewport(VIEWPORT, { ...VIEWPORT, scrollY: 0 })).toBe(false)
  })

  it('treats "no camera" as equal only to itself', () => {
    expect(sameViewport(null, null)).toBe(true)
    expect(sameViewport(null, VIEWPORT)).toBe(false)
    expect(sameViewport(VIEWPORT, null)).toBe(false)
  })
})
