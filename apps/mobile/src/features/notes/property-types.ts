import type { IconName } from '@/components/ui/icon'
import type { Color, ThemeColors } from '@/theme/colors'
import { STATUS_OPTIONS, type MobilePropertyType } from './note-ops'

/**
 * One table for everything the UI needs to know about a property type.
 *
 * Three call sites read it — the inline row's icon lane, the add sheet's type
 * list, and the value renderer — so a new type is one entry here rather than
 * three conditionals that drift apart.
 */
export interface PropertyTypeEntry {
  icon: IconName
  label: string
  /**
   * Offered in the add sheet. `project` and `multiselect` are not, because
   * neither can be authored from a bare name, but a note that already carries
   * one still renders it inline.
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
  multiselect: { icon: 'tag', label: 'Multi-select', addable: false, emptyValue: [] },
  project: { icon: 'project', label: 'Project', addable: false, emptyValue: [] }
}

/** The add sheet's list, in table order. Derived so it cannot drift from the table. */
export const addablePropertyTypes = (Object.keys(propertyTypes) as MobilePropertyType[]).filter(
  (type) => propertyTypes[type].addable
)

/**
 * Contracts carries colour NAMES, not hex. Every one of these pastels reads
 * `text.primary` at 9.4:1 or better.
 */
export function statusPastel(c: ThemeColors, color: string): Color {
  switch (color) {
    case 'amber':
      return c.pastel.sand
    case 'emerald':
      return c.pastel.sage
    case 'rose':
      return c.pastel.rose
    default:
      return c.pastel.grey
  }
}
