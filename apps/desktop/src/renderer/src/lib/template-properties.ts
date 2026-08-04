/**
 * Template Property Model
 *
 * `TemplateProperty` is the stored truth. The note editor's `InfoSection`
 * speaks a narrower `PropertyType`, so a template type with no UI equivalent
 * (rating) is displayed as text — but only displayed. Nothing maps back, which
 * is what keeps `select` / `multiselect` / `rating` from degrading to `text` on
 * save the way the previous editor's two-way mapping did.
 *
 * Select/multiselect choices are not carried on the UI shape: `PropertyRow`
 * resolves them from the property-definition store by property name. The stored
 * `options` array is preserved untouched regardless.
 */

import type { NewProperty, Property, PropertyType } from '@/components/note/info-section'
import { getUniquePropertyName } from '@/lib/property-utils'
import type { TemplateProperty } from '@/services/templates-service'

export interface EditableProperty {
  id: string
  property: TemplateProperty
}

let idCounter = 0
function nextId(): string {
  idCounter += 1
  return `tplprop-${idCounter}`
}

/** Display-only widening. Never used to write back. */
function toUiType(type: TemplateProperty['type']): PropertyType {
  switch (type) {
    case 'number':
    case 'checkbox':
    case 'date':
    case 'url':
    case 'select':
    case 'multiselect':
      return type
    default:
      return 'text'
  }
}

function defaultValueFor(type: PropertyType): unknown {
  switch (type) {
    case 'checkbox':
      return false
    case 'number':
      return 0
    case 'date':
      return null
    default:
      return ''
  }
}

/** UI types map 1:1 onto stored types except `status`, which stores as select. */
function toStoredType(type: PropertyType): TemplateProperty['type'] {
  return type === 'status' ? 'select' : type
}

export function toEditableProperties(props: TemplateProperty[]): EditableProperty[] {
  return props.map((property) => ({ id: nextId(), property }))
}

export function toUiProperties(items: EditableProperty[]): Property[] {
  return items.map(({ id, property }) => ({
    id,
    name: property.name,
    type: toUiType(property.type),
    value: property.value,
    isCustom: true
  }))
}

export function toTemplateProperties(items: EditableProperty[]): TemplateProperty[] {
  return items.map((item) => item.property)
}

export function addProperty(items: EditableProperty[], next: NewProperty): EditableProperty[] {
  const name = getUniquePropertyName(
    next.name,
    items.map((item) => item.property.name)
  )
  return [
    ...items,
    {
      id: nextId(),
      property: { name, type: toStoredType(next.type), value: defaultValueFor(next.type) }
    }
  ]
}

export function setPropertyValue(
  items: EditableProperty[],
  id: string,
  value: unknown
): EditableProperty[] {
  return items.map((item) =>
    item.id === id ? { ...item, property: { ...item.property, value } } : item
  )
}

export function setPropertyName(
  items: EditableProperty[],
  id: string,
  name: string
): EditableProperty[] {
  return items.map((item) =>
    item.id === id ? { ...item, property: { ...item.property, name } } : item
  )
}

export function reorderProperties(
  items: EditableProperty[],
  orderedIds: string[]
): EditableProperty[] {
  const byId = new Map(items.map((item) => [item.id, item]))
  const reordered = orderedIds
    .map((id) => byId.get(id))
    .filter((item): item is EditableProperty => item !== undefined)
  // Anything the caller did not list keeps its relative position at the end.
  const listed = new Set(orderedIds)
  const missing = items.filter((item) => !listed.has(item.id))
  return [...reordered, ...missing]
}

export function removeProperty(items: EditableProperty[], id: string): EditableProperty[] {
  return items.filter((item) => item.id !== id)
}
