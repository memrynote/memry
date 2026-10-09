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

export function fieldTypeLabelKey(type: FieldType): string {
  return `tagFields.settings.types.${type}`
}
