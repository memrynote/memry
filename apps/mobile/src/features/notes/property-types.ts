import type { IconName } from '@/components/ui/icon'
import { STATUS_OPTIONS, type MobilePropertyType } from './note-ops'

/**
 * One table for everything the UI needs to know about a property type.
 *
 * Three call sites read it — the inline row's icon lane, the add sheet's type
 * list, and the value renderer — so a new type is one entry here rather than
 * three conditionals that drift apart. Icons match the desktop's
 * `PROPERTY_TYPE_ICONS` glyph for glyph.
 */
export interface PropertyTypeEntry {
  icon: IconName
  label: string
  /**
   * Offered in the add sheet.
   *
   * `select`, `multiselect` and `status` are: their options come from the
   * vault's replicated definition, and a new one starts with none. `relation`
   * and `project` are not — neither can be authored from a bare name, but a
   * note that already carries one still renders it inline.
   */
  addable: boolean
  emptyValue: unknown
}

const statusDefault = (STATUS_OPTIONS.find((option) => option.default) ?? STATUS_OPTIONS[0]).value

export const propertyTypes: Record<MobilePropertyType, PropertyTypeEntry> = {
  text: { icon: 'text', label: 'Text', addable: true, emptyValue: '' },
  number: { icon: 'hash', label: 'Number', addable: true, emptyValue: 0 },
  date: { icon: 'calendar', label: 'Date', addable: true, emptyValue: '' },
  checkbox: { icon: 'square-check-big', label: 'Checkbox', addable: true, emptyValue: false },
  url: { icon: 'link', label: 'URL', addable: true, emptyValue: '' },
  status: { icon: 'list', label: 'Status', addable: true, emptyValue: statusDefault },
  select: { icon: 'list', label: 'Select', addable: true, emptyValue: '' },
  multiselect: { icon: 'tags', label: 'Multi-select', addable: true, emptyValue: [] },
  relation: { icon: 'link-2', label: 'Relation', addable: false, emptyValue: [] },
  project: { icon: 'project', label: 'Project', addable: false, emptyValue: [] }
}

/** The add sheet's list, in table order. Derived so it cannot drift from the table. */
export const addablePropertyTypes = (Object.keys(propertyTypes) as MobilePropertyType[]).filter(
  (type) => propertyTypes[type].addable
)

/** The types whose value is one or more option chips out of a definition. */
export const SELECT_TYPES: readonly MobilePropertyType[] = ['select', 'multiselect', 'status']

/** The types that open their own picker rather than an inline text field. */
export function isPickerType(type: MobilePropertyType): boolean {
  return (
    type === 'checkbox' ||
    type === 'date' ||
    type === 'relation' ||
    type === 'project' ||
    SELECT_TYPES.includes(type)
  )
}
