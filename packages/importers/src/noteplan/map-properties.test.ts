import { describe, it, expect } from 'vitest'
import { mapProperties } from './map-properties.ts'

describe('mapProperties', () => {
  it('keeps semantic keys and drops NotePlan styling keys', () => {
    const result = mapProperties({
      type: 'area',
      status: 'Active',
      owner: 'Web',
      icon: 'truck',
      'icon-color': 'purple-600',
      'bg-color': 'purple-50',
      'bg-color-dark': 'purple-950',
      'bg-pattern': 'dotted'
    })

    expect(result.properties).toEqual({ type: 'area', status: 'Active', owner: 'Web' })
    expect(result.dropped).toEqual([
      'bg-color',
      'bg-color-dark',
      'bg-pattern',
      'icon',
      'icon-color'
    ])
  })

  it('returns empty results for empty frontmatter', () => {
    expect(mapProperties({})).toEqual({ properties: {}, dropped: [] })
  })

  it('drops undefined values', () => {
    expect(mapProperties({ type: 'guide', owner: undefined })).toEqual({
      properties: { type: 'guide' },
      dropped: []
    })
  })
})
