import { describe, it, expect } from 'vitest'
import { FEATURES_SETTINGS_DEFAULTS, FeaturesSettingsSchema } from './settings-schemas'
import { featureForTabType, FEATURE_KEYS } from './feature-flags'

describe('feature flags', () => {
  it('defaults every feature on, including spatialCanvas', () => {
    expect(FeaturesSettingsSchema.parse(FEATURES_SETTINGS_DEFAULTS)).toEqual({
      home: true,
      inbox: true,
      journal: true,
      tasks: true,
      calendar: true,
      graph: true,
      spatialCanvas: true
    })
  })

  it('maps a known tab type to its feature key', () => {
    expect(featureForTabType('tasks')).toBe('tasks')
    expect(featureForTabType('calendar')).toBe('calendar')
  })

  it('returns null for a non-feature tab type', () => {
    expect(featureForTabType('note')).toBeNull()
    expect(featureForTabType('settings')).toBeNull()
  })

  it('keeps FEATURE_KEYS aligned with the schema shape', () => {
    expect([...FEATURE_KEYS].sort()).toEqual(Object.keys(FEATURES_SETTINGS_DEFAULTS).sort())
  })
})
