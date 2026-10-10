import type { NewFieldSpec } from '@memry/contracts/tag-schema-api'
import { PropertiesChannels } from '@memry/contracts/ipc-channels'
import type { PropertyType } from '@memry/contracts/property-types'
import {
  getOrCreateTag,
  readTagSchemaColumn,
  writeTagSchemaColumn
} from '@main/database/queries/tag-definitions'
import type { DataDb } from '../../database/types'
import { broadcastToAllWindows } from '../../lib/window-broadcast'
import { getMainI18n } from '../../lib/main-i18n'
import { PropertyDefinitionsService } from '../../vault/property-definitions'
import { syncTagDefinitionUpdate } from '../runtime-effects'
import {
  applySchemaEdit,
  canonicalFieldName,
  parseSchemaColumn,
  serializeSchema,
  type SchemaBodyEdit,
  type SchemaEditError,
  type SchemaEditResult
} from '../tag-schema'
import { tagKey } from '@memry/shared/tag-fold'
import { loadResolvedTags } from './read'

const ERROR_KEYS: Record<SchemaEditError['code'], string> = {
  'reserved-name': 'errors:tagFields.reservedName',
  'duplicate-field': 'errors:tagFields.duplicateField',
  'unknown-field': 'errors:tagFields.unknownField',
  'inherited-field': 'errors:tagFields.inheritedField',
  cycle: 'errors:tagFields.cycle',
  'unreadable-schema': 'errors:tagFields.unreadableSchema'
}

export function schemaEditFailure(error: SchemaEditError): Error {
  const { code, ...values } = error
  return new Error(getMainI18n().t(ERROR_KEYS[code], values))
}

export function emitTagSchemasChanged(): void {
  broadcastToAllWindows('notes:tags-changed', {})
}

export function planSchemaEdit(db: DataDb, key: string, edit: SchemaBodyEdit): SchemaEditResult {
  const parsed = parseSchemaColumn(readTagSchemaColumn(db, key))
  if (parsed.kind === 'unreadable') throw schemaEditFailure({ code: 'unreadable-schema' })
  const result = applySchemaEdit(parsed.kind === 'ok' ? parsed.schema : null, edit, {
    tag: key,
    resolved: loadResolvedTags(db)
  })
  if (!result.ok) throw schemaEditFailure(result.error)
  return result
}

export function saveSchemaEdit(db: DataDb, tag: string, edit: SchemaBodyEdit): boolean {
  const key = tagKey(tag)
  const result = planSchemaEdit(db, key, edit)
  if (!result.ok || !result.changed) return false
  getOrCreateTag(db, key)
  writeTagSchemaColumn(db, key, serializeSchema(result.next))
  syncTagDefinitionUpdate(key)
  return true
}

export function fieldNameFor(db: DataDb, typed: string): string {
  return canonicalFieldName(typed, knownFieldNames(db)).name
}

function knownFieldNames(db: DataDb): string[] {
  const names = (PropertyDefinitionsService.tryGet()?.getAll() ?? []).map((d) => d.name)
  for (const tag of loadResolvedTags(db).values()) {
    for (const field of tag.ownFields) names.push(field.name)
  }
  return names
}

export async function ensureFieldDefinition(
  spec: NewFieldSpec & { showOnCalendar?: boolean }
): Promise<void> {
  if (spec.type === 'relation') return
  const service = PropertyDefinitionsService.tryGet()
  if (!service || service.get(spec.name)) return
  const name = spec.name
  await service.upsert({
    name,
    type: spec.type satisfies PropertyType,
    ...(spec.options ? { options: spec.options } : {}),
    ...(spec.showOnCalendar ? { showOnCalendar: true } : {})
  })
  broadcastToAllWindows(PropertiesChannels.events.DEFINITION_CHANGED, { name })
}

export async function addField(
  db: DataDb,
  tag: string,
  spec: NewFieldSpec,
  index?: number
): Promise<boolean> {
  if (spec.type === 'relation' && !spec.relation) {
    throw new Error(getMainI18n().t('errors:tagFields.relationTargetRequired'))
  }
  const name = fieldNameFor(db, spec.name)
  const edit: SchemaBodyEdit = {
    kind: 'add-field',
    field: { name, relation: spec.type === 'relation' ? (spec.relation ?? null) : null },
    ...(index !== undefined ? { index } : {})
  }
  planSchemaEdit(db, tagKey(tag), edit)
  await ensureFieldDefinition({ ...spec, name })
  return saveSchemaEdit(db, tag, edit)
}
