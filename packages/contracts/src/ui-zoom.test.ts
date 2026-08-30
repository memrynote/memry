/**
 * UI Zoom Ladder Tests
 *
 * The ladder is the reconciliation point for every zoom value the app reads:
 * a persisted config, an IPC payload, or a value written by a future version.
 */

import { describe, it, expect } from 'vitest'
import { ZOOM_FACTORS, DEFAULT_ZOOM_FACTOR, clampZoomFactor, stepZoomFactor } from './ui-zoom'

describe('clampZoomFactor', () => {
  it('#given a value already on the ladder #then returns it unchanged', () => {
    for (const factor of ZOOM_FACTORS) {
      expect(clampZoomFactor(factor)).toBe(factor)
    }
  })

  it('#given a value below the ladder #then returns the lowest rung', () => {
    expect(clampZoomFactor(0.1)).toBe(0.75)
    expect(clampZoomFactor(-4)).toBe(0.75)
  })

  it('#given a value above the ladder #then returns the highest rung', () => {
    expect(clampZoomFactor(3)).toBe(2)
    expect(clampZoomFactor(1000)).toBe(2)
  })

  it('#given a value between two rungs #then returns the nearest rung', () => {
    expect(clampZoomFactor(1.07)).toBe(1)
    expect(clampZoomFactor(1.12)).toBe(1.15)
    expect(clampZoomFactor(1.9)).toBe(2)
    expect(clampZoomFactor(0.79)).toBe(0.75)
  })

  it('#given a non-finite number #then returns the default', () => {
    expect(clampZoomFactor(Number.NaN)).toBe(DEFAULT_ZOOM_FACTOR)
    expect(clampZoomFactor(Number.POSITIVE_INFINITY)).toBe(DEFAULT_ZOOM_FACTOR)
    expect(clampZoomFactor(Number.NEGATIVE_INFINITY)).toBe(DEFAULT_ZOOM_FACTOR)
  })

  it('#given a non-numeric value #then returns the default', () => {
    expect(clampZoomFactor(undefined)).toBe(DEFAULT_ZOOM_FACTOR)
    expect(clampZoomFactor(null)).toBe(DEFAULT_ZOOM_FACTOR)
    expect(clampZoomFactor('1.5')).toBe(DEFAULT_ZOOM_FACTOR)
    expect(clampZoomFactor({ factor: 1.5 })).toBe(DEFAULT_ZOOM_FACTOR)
    expect(clampZoomFactor([1.5])).toBe(DEFAULT_ZOOM_FACTOR)
  })
})

describe('stepZoomFactor', () => {
  it('#given a rung mid-ladder #then moves exactly one rung in each direction', () => {
    expect(stepZoomFactor(1, 1)).toBe(1.15)
    expect(stepZoomFactor(1, -1)).toBe(0.85)
  })

  it('#given the top rung #when stepping up #then saturates instead of wrapping', () => {
    expect(stepZoomFactor(2, 1)).toBe(2)
  })

  it('#given the bottom rung #when stepping down #then saturates instead of wrapping', () => {
    expect(stepZoomFactor(0.75, -1)).toBe(0.75)
  })

  it('#given an off-ladder value #then steps from its nearest rung', () => {
    expect(stepZoomFactor(1.07, 1)).toBe(1.15)
    expect(stepZoomFactor(1.07, -1)).toBe(0.85)
  })

  it('#given a garbage value #then steps from the default rung', () => {
    expect(stepZoomFactor(Number.NaN, 1)).toBe(1.15)
  })

  it('#given repeated steps up from the bottom #then walks the whole ladder', () => {
    let current: number = ZOOM_FACTORS[0]
    const walked = [current]
    for (let i = 0; i < ZOOM_FACTORS.length; i++) {
      current = stepZoomFactor(current, 1)
      walked.push(current)
    }
    expect(walked).toEqual([...ZOOM_FACTORS, 2])
  })
})
