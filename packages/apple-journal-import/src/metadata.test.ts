import { describe, it, expect } from 'vitest'
import { tokensToFrontmatter } from './metadata.ts'

describe('tokensToFrontmatter', () => {
  it('maps generic-map to location', () => {
    expect(tokensToFrontmatter(['generic-map'])).toEqual({ location: true })
  })

  it('maps multi-pin-map to location', () => {
    expect(tokensToFrontmatter(['multi-pin-map'])).toEqual({ location: true })
  })

  it('ignores photo/live-photo/video asset types', () => {
    expect(tokensToFrontmatter(['photo', 'live-photo', 'video'])).toEqual({})
  })

  it('kebab-cases other recognised tokens', () => {
    const result = tokensToFrontmatter(['activity-type', 'media-title'])
    expect(result).toEqual({ 'activity-type': true, 'media-title': true })
  })

  it('returns empty for empty tokens', () => {
    expect(tokensToFrontmatter([])).toEqual({})
  })

  it('deduplicates location from multiple map tokens', () => {
    const result = tokensToFrontmatter(['generic-map', 'multi-pin-map'])
    expect(result).toEqual({ location: true })
  })
})
