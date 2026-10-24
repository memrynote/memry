import { describe, it, expect } from 'vitest'
import { confidenceBand } from './confidence-band'

describe('confidenceBand', () => {
  it('classifies high scores as strong', () => {
    expect(confidenceBand(0.9)).toBe('strong')
    expect(confidenceBand(0.66)).toBe('strong')
  })

  it('classifies mid scores as likely', () => {
    expect(confidenceBand(0.65)).toBe('likely')
    expect(confidenceBand(0.5)).toBe('likely')
  })

  it('classifies low scores as weak', () => {
    expect(confidenceBand(0.49)).toBe('weak')
    expect(confidenceBand(0)).toBe('weak')
  })
})
