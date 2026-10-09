import type { PresetKey } from '@memry/contracts/tag-schema'

/** A tag's name as a title ("person" → "Person"): group headers, tag pages, menus. */
export function tagDisplayName(name: string): string {
  return name.charAt(0).toLocaleUpperCase() + name.slice(1)
}

/** A ready-made tag's names in the app language. */
export interface PresetNames {
  name: string
  plural: string
}

/**
 * A ready-made tag still carrying its ready-made name reads in the plural
 * ("People"); null for any other tag, a renamed one included.
 */
export function presetPlural(
  tag: { name: string; ownPreset: PresetKey | null },
  presetNames: (preset: PresetKey) => PresetNames
): string | null {
  if (!tag.ownPreset) return null
  const names = presetNames(tag.ownPreset)
  return names.name.toLocaleLowerCase() === tag.name.toLocaleLowerCase() ? names.plural : null
}

/** The label of a group of a tag's objects (@ menu "PEOPLE", D1). */
export function objectGroupLabel(
  tag: { name: string; ownPreset: PresetKey | null },
  presetNames: (preset: PresetKey) => PresetNames
): string {
  return presetPlural(tag, presetNames) ?? tagDisplayName(tag.name)
}
