import type { PresetOffer } from '@memry/contracts/tag-schema-api'
import type { PresetKey, ResolvedTag } from '@memry/contracts/tag-schema'
import { getOrCreateTag, listTagDefinitionRows } from '@main/database/queries/tag-definitions'
import { updateTagColor, updateTagIcon } from '@main/database/queries/notes'
import { getSetting, setSetting } from '@main/database/queries/settings'
import { headerObjectNoteIds } from '@main/database/queries/tag-schema-counts'
import type { DataDb, IndexDb } from '../database/types'
import { getMainI18n } from '../lib/main-i18n'
import { createTemplate } from '../vault/templates'
import { syncTagDefinitionUpdate } from './runtime-effects'
import { PRESET_CATALOG, presetSpec, type PresetSpec } from './preset-catalog'
import { ensureFieldDefinition, fieldNameFor, saveSchemaEdit } from './schema/edit'
import { loadResolvedTags } from './schema/read'
import { type NewFieldBody } from './tag-schema'
import { tagKey } from '@memry/shared/tag-fold'

export const PRESET_OFFER_DISMISSED_SETTING = 'tagFields.presetOfferDismissed'

const t = (key: string): string => getMainI18n().t(key)

function localizedTagName(spec: PresetSpec): string {
  const i18n = getMainI18n()
  return tagKey(i18n.t(spec.nameKey).toLocaleLowerCase(i18n.language))
}

function templateBody(spec: PresetSpec): string {
  return spec.template.sections
    .map((section) =>
      [`## ${t(section.headingKey)}`, ...(section.hintKey ? [t(section.hintKey)] : [])].join('\n')
    )
    .join('\n\n')
    .concat('\n')
}

function ownerOf(preset: PresetKey, resolved: ReadonlyMap<string, ResolvedTag>): string | null {
  for (const tag of resolved.values()) if (tag.ownPreset === preset) return tag.key
  return null
}

function missingTargets(
  spec: PresetSpec,
  resolved: ReadonlyMap<string, ResolvedTag>,
  seen = new Set<PresetKey>([spec.key])
): string[] {
  const names: string[] = []
  for (const field of spec.fields) {
    const target = field.relation?.target
    if (!target || seen.has(target) || ownerOf(target, resolved)) continue
    seen.add(target)
    const targetSpec = presetSpec(target)
    names.push(localizedTagName(targetSpec), ...missingTargets(targetSpec, resolved, seen))
  }
  return names
}

export function presetStripDismissed(db: DataDb): boolean {
  return getSetting(db, PRESET_OFFER_DISMISSED_SETTING) === '1'
}

export function dismissPresetOffer(db: DataDb): void {
  setSetting(db, PRESET_OFFER_DISMISSED_SETTING, '1')
}

export function presetOffers(
  db: DataDb,
  indexDb: IndexDb,
  resolved: ReadonlyMap<string, ResolvedTag>
): PresetOffer[] {
  const definitions = new Set(listTagDefinitionRows(db).map((row) => tagKey(row.name)))
  return PRESET_CATALOG.map((spec) => {
    const name = localizedTagName(spec)
    const owner = ownerOf(spec.key, resolved)
    const existing = owner ?? (definitions.has(name) ? name : null)
    return {
      key: spec.key,
      name,
      icon: spec.icon,
      color: spec.color,
      fields: spec.fields.map((field) => ({
        name: t(field.nameKey),
        type: field.type,
        relationTarget: field.relation
          ? (ownerOf(field.relation.target, resolved) ??
            localizedTagName(presetSpec(field.relation.target)))
          : null
      })),
      templateSections: spec.template.sections.map((section) => t(section.headingKey)),
      state: owner ? 'added' : existing ? 'add-fields' : 'add',
      existingTag: existing
        ? { key: existing, usage: headerObjectNoteIds(indexDb, [existing]).length }
        : null,
      alsoAdds: owner ? [] : missingTargets(spec, resolved)
    }
  })
}

export async function addPreset(
  db: DataDb,
  preset: PresetKey,
  explicitTag?: string,
  adding = new Set<PresetKey>()
): Promise<string> {
  const spec = presetSpec(preset)
  const key = explicitTag ? tagKey(explicitTag) : localizedTagName(spec)
  adding.add(preset)

  const fields: NewFieldBody[] = []
  for (const field of spec.fields) {
    const name = fieldNameFor(db, t(field.nameKey))
    if (field.type === 'relation' && field.relation) {
      const target = field.relation.target
      const targetTag =
        ownerOf(target, loadResolvedTags(db)) ??
        (adding.has(target) ? null : await addPreset(db, target, undefined, adding))
      fields.push({
        name,
        relation: {
          target: targetTag,
          many: field.relation.many,
          inverse: t(field.relation.inverseKey)
        }
      })
      continue
    }
    await ensureFieldDefinition({
      name,
      type: field.type === 'relation' ? 'text' : field.type,
      ...(field.options
        ? { options: field.options.map((o) => ({ value: t(o.valueKey), color: o.color })) }
        : {}),
      ...(field.showOnCalendar ? { showOnCalendar: true } : {})
    })
    fields.push({ name, relation: null })
  }

  const isNew = !listTagDefinitionRows(db).some((row) => tagKey(row.name) === key)
  const row = getOrCreateTag(db, key)
  let appearanceChanged = false
  if (isNew) {
    updateTagColor(db, key, spec.color)
    appearanceChanged = true
  }
  if (row.icon === null) {
    updateTagIcon(db, key, spec.icon)
    appearanceChanged = true
  }

  const own = loadResolvedTags(db).get(key)
  const hasTemplate = own?.template !== null && own?.template?.inheritedFrom === null
  const template = hasTemplate
    ? null
    : {
        id: (
          await createTemplate({
            name: t(spec.template.nameKey),
            content: templateBody(spec),
            tags: [],
            properties: []
          })
        ).id,
        autofill: true
      }

  const schemaChanged = saveSchemaEdit(db, key, { kind: 'merge-preset', fields, template, preset })
  if (appearanceChanged && !schemaChanged) syncTagDefinitionUpdate(key)
  return key
}
