import { PRESET_KEYS, type PresetKey } from '@memry/contracts/tag-schema'
import type { TagSchemaSnapshot } from '@memry/contracts/tag-schema-api'

export type CreateOption =
  | { kind: 'tag'; tag: string; name: string; lastUsed: boolean }
  | { kind: 'preset'; preset: PresetKey; name: string; icon: string | null; color: string }
  | { kind: 'plain' }

const presetRank = (preset: PresetKey | null): number =>
  preset === null ? PRESET_KEYS.length : PRESET_KEYS.indexOf(preset)

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
    .map((offer): CreateOption => ({
      kind: 'preset',
      preset: offer.key,
      name: offer.name,
      icon: offer.icon,
      color: offer.color
    }))
  return [...tags, ...presets, { kind: 'plain' }]
}
