import type { FeaturesSettings } from './settings-schemas'

export type FeatureKey = keyof FeaturesSettings

export const FEATURE_KEYS = [
  'home',
  'inbox',
  'journal',
  'tasks',
  'calendar',
  'graph',
  'spatialCanvas'
] as const

/**
 * A tab/page type maps 1:1 to a feature key when it represents a toggleable
 * feature. Returns null for everything else (notes, settings, etc.).
 */
export function featureForTabType(type: string): FeatureKey | null {
  return (FEATURE_KEYS as readonly string[]).includes(type) ? (type as FeatureKey) : null
}
