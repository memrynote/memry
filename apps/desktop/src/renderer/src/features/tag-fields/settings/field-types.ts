import {
  ArrowUpRight,
  Calendar,
  CheckSquare,
  Hash,
  Link,
  List,
  ListChecks,
  Tags,
  Type,
  type AppIcon
} from '@/lib/icons'
import type { FieldType } from '@memry/contracts/tag-schema'

export const FIELD_TYPE_ICONS: Record<FieldType, AppIcon> = {
  text: Type,
  number: Hash,
  date: Calendar,
  url: Link,
  status: ListChecks,
  select: List,
  multiselect: Tags,
  checkbox: CheckSquare,
  relation: ArrowUpRight
}

/** B2's order of the "New field type" group. */
export const NEW_FIELD_TYPE_ORDER: readonly FieldType[] = [
  'text',
  'number',
  'date',
  'url',
  'status',
  'select',
  'multiselect',
  'checkbox',
  'relation'
]

/** i18n key of a type's label, under `tagFields.settings.types`. */
export function fieldTypeLabelKey(type: FieldType): string {
  return `tagFields.settings.types.${type}`
}
