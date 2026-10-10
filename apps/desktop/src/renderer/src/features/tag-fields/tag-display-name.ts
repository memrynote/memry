import type { PresetKey } from '@memry/contracts/tag-schema'

export function tagDisplayName(name: string): string {
  return name.charAt(0).toLocaleUpperCase() + name.slice(1)
}

export interface PresetNames {
  name: string
  plural: string
}

export function presetPlural(
  tag: { name: string; ownPreset: PresetKey | null },
  presetNames: (preset: PresetKey) => PresetNames
): string | null {
  if (!tag.ownPreset) return null
  const names = presetNames(tag.ownPreset)
  return names.name.toLocaleLowerCase() === tag.name.toLocaleLowerCase() ? names.plural : null
}

export function objectGroupLabel(
  tag: { name: string; ownPreset: PresetKey | null },
  presetNames: (preset: PresetKey) => PresetNames
): string {
  return presetPlural(tag, presetNames) ?? tagDisplayName(tag.name)
}
