/**
 * Note → Template Mapping
 *
 * Pure translation from a note's editable surface to a template create input.
 * The body is carried verbatim: no `{{title}}` substitution, because a note
 * whose text happens to repeat its own title would be rewritten in place.
 */

import { mapPropertyType, type PropertyValue } from '@/lib/property-utils'
import { TEMPLATE_PROPERTY_TYPE_BY_UI_TYPE } from '@/lib/template-properties'
import type { TemplateCreateInput, TemplateProperty } from '@/services/templates-service'

/** `TemplateCreateSchema` caps the name at 200; note titles are uncapped. */
export const MAX_TEMPLATE_NAME_LENGTH = 200

export interface NoteTemplateSource {
  title: string
  content: string
  tags: string[]
  properties: PropertyValue[]
}

export function buildTemplateFromNote(source: NoteTemplateSource): TemplateCreateInput {
  const properties: TemplateProperty[] = []
  for (const property of source.properties) {
    const type = TEMPLATE_PROPERTY_TYPE_BY_UI_TYPE[mapPropertyType(property.type)]
    if (type === null) {
      continue
    }
    properties.push({ name: property.name, type, value: property.value })
  }

  const tags = [...new Set(source.tags.filter((tag) => tag.trim().length > 0))]

  return {
    name: source.title.trim().slice(0, MAX_TEMPLATE_NAME_LENGTH),
    tags,
    properties,
    content: source.content
  }
}
