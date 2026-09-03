import { describe, it, expect } from 'vitest'
import {
  ZOOM_FACTOR_MIN,
  ZOOM_FACTOR_MAX,
  ZOOM_FACTOR_DEFAULT,
  clampZoomFactor,
  stepZoomFactor,
  zoomPercent
} from './app-zoom'

describe('clampZoomFactor', () => {
  it('returns an in-range factor untouched', () => {
    expect(clampZoomFactor(1.3)).toBe(1.3)
    expect(clampZoomFactor(ZOOM_FACTOR_MIN)).toBe(ZOOM_FACTOR_MIN)
    expect(clampZoomFactor(ZOOM_FACTOR_MAX)).toBe(ZOOM_FACTOR_MAX)
  })

  it('falls back to the default for anything that is not a finite number', () => {
    expect(clampZoomFactor(undefined)).toBe(ZOOM_FACTOR_DEFAULT)
    expect(clampZoomFactor(null)).toBe(ZOOM_FACTOR_DEFAULT)
    expect(clampZoomFactor(Number.NaN)).toBe(ZOOM_FACTOR_DEFAULT)
    expect(clampZoomFactor(Number.POSITIVE_INFINITY)).toBe(ZOOM_FACTOR_DEFAULT)
    expect(clampZoomFactor(Number.NEGATIVE_INFINITY)).toBe(ZOOM_FACTOR_DEFAULT)
    expect(clampZoomFactor('1.5')).toBe(ZOOM_FACTOR_DEFAULT)
    expect(clampZoomFactor({ zoomFactor: 1.5 })).toBe(ZOOM_FACTOR_DEFAULT)
  })

  it('clamps a factor at both ends', () => {
    expect(clampZoomFactor(0.1)).toBe(ZOOM_FACTOR_MIN)
    expect(clampZoomFactor(-4)).toBe(ZOOM_FACTOR_MIN)
    expect(clampZoomFactor(12)).toBe(ZOOM_FACTOR_MAX)
  })

  it('snaps a value between stops onto the nearest one', () => {
    expect(clampZoomFactor(1.04)).toBe(1)
    expect(clampZoomFactor(1.06)).toBe(1.1)
    expect(clampZoomFactor(0.7000000000000001)).toBe(0.7)
  })

  it('snaps before clamping, so a near-miss at the edge survives', () => {
    expect(clampZoomFactor(0.49)).toBe(ZOOM_FACTOR_MIN)
    expect(clampZoomFactor(2.04)).toBe(ZOOM_FACTOR_MAX)
  })
})

describe('stepZoomFactor', () => {
  it('moves one stop in either direction', () => {
    expect(stepZoomFactor(1, 1)).toBe(1.1)
    expect(stepZoomFactor(1, -1)).toBe(0.9)
  })

  it('stops at each end rather than running past it', () => {
    expect(stepZoomFactor(ZOOM_FACTOR_MAX, 1)).toBe(ZOOM_FACTOR_MAX)
    expect(stepZoomFactor(ZOOM_FACTOR_MIN, -1)).toBe(ZOOM_FACTOR_MIN)
  })

  it('brings an off-grid current value back onto the grid', () => {
    expect(stepZoomFactor(1.04, 1)).toBe(1.1)
    expect(stepZoomFactor(99, -1)).toBe(1.9)
  })

  it('lands exactly on a stop after a run of steps, with no float dust', () => {
    let factor = ZOOM_FACTOR_MIN
    for (let i = 0; i < 10; i++) factor = stepZoomFactor(factor, 1)
    expect(factor).toBe(1.5)

    for (let i = 0; i < 10; i++) factor = stepZoomFactor(factor, -1)
    expect(factor).toBe(ZOOM_FACTOR_MIN)
  })
})

describe('zoomPercent', () => {
  it('renders a factor as whole percent', () => {
    expect(zoomPercent(1.5)).toBe(150)
    expect(zoomPercent(ZOOM_FACTOR_DEFAULT)).toBe(100)
    expect(zoomPercent(ZOOM_FACTOR_MIN)).toBe(50)
    expect(zoomPercent(ZOOM_FACTOR_MAX)).toBe(200)
    expect(zoomPercent(0.7)).toBe(70)
  })
})
