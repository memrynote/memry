import { PRESET_KEYS, type PresetKey } from '@memry/contracts/tag-schema'
import type { TagSchemaSnapshot } from '@memry/contracts/tag-schema-api'

export type CreateOption =
  | { kind: 'tag'; tag: string; name: string; lastUsed: boolean }
  /** A ready-made tag not added yet: picking it adds it first ("first use from @"). */
  | { kind: 'preset'; preset: PresetKey; name: string }
  | { kind: 'plain' }

const presetRank = (preset: PresetKey | null): number =>
  preset === null ? PRESET_KEYS.length : PRESET_KEYS.indexOf(preset)

/**
 * D2 panel 1: "Create {title} as". Tags with fields, the last used first, then
 * ready-made ones in catalogue order, then the rest by name; then ready-made
 * tags not added yet; Plain note always last.
 */
export function buildCreateOptions(
  snapshot: TagSchemaSnapshot | undefined,
  lastTag: string | null
): CreateOption[] {
  const tags = Object.values(snapshot?.tags ?? {})
    .filter((tag) => tag.hasFields)
    .sort(
      (a, b) =>
        Number(b.key === lastTag) - Number(a.key === lastTag) ||
        presetRank(a.ownPreset) - presetRank(b.ownPreset) ||
        a.name.localeCompare(b.name)
    )
    .map((tag): CreateOption => ({
      kind: 'tag',
      tag: tag.key,
      name: tag.name,
      lastUsed: tag.key === lastTag
    }))
  const presets = (snapshot?.presets ?? [])
    .filter((offer) => offer.state !== 'added')
    .map((offer): CreateOption => ({ kind: 'preset', preset: offer.key, name: offer.name }))
  return [...tags, ...presets, { kind: 'plain' }]
}
