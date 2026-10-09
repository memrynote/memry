import type { ResolvedTag } from '@memry/contracts/tag-schema'
import { listTagDefinitionRows } from '@main/database/queries/tag-definitions'
import type { DataDb } from '../../database/types'
import { PropertyDefinitionsService } from '../../vault/property-definitions'
import {
  parseSchemaColumn,
  resolveTagSchemas,
  type PropertyTypeLookup,
  type TagDefinitionInput
} from '../tag-schema'
import { tagKey } from '@memry/shared/tag-fold'

/** Field types come from the vault-wide property definitions; none loaded reads as text. */
const propertyTypes: PropertyTypeLookup = {
  get: (name) => PropertyDefinitionsService.tryGet()?.get(name)
}

export function loadTagDefinitions(db: DataDb): Map<string, TagDefinitionInput> {
  const defs = new Map<string, TagDefinitionInput>()
  for (const row of listTagDefinitionRows(db)) {
    defs.set(tagKey(row.name), {
      name: row.name,
      color: row.color,
      icon: row.icon,
      schema: parseSchemaColumn(row.schema)
    })
  }
  return defs
}

/** Every tag with a schema, resolved through `extends`. */
export function loadResolvedTags(db: DataDb): Map<string, ResolvedTag> {
  return resolveTagSchemas(loadTagDefinitions(db), propertyTypes)
}

/** Lowercase names of the tags with fields, own or inherited. */
export function tagsWithFields(db: DataDb): Set<string> {
  const keys = new Set<string>()
  for (const tag of loadResolvedTags(db).values()) if (tag.hasFields) keys.add(tag.key)
  return keys
}
