/**
 * Select, multiselect and status values in the folder table.
 *
 * They read as the coloured pills the note panel shows, in the colour the
 * property's definition gives each option. A value the definition no longer
 * lists still shows, in grey, as it does there. Where a cell can be edited, the
 * same picker as the note panel opens from the pill.
 */

import { memo } from 'react'
import { cn } from '@/lib/utils'
import { usePropertyOptions } from '@/hooks/use-property-options'
import {
  MultiselectEditor,
  SelectChip,
  SelectEditor,
  StatusEditor
} from '@/components/note/info-section/editors'

/** Pills shown before the rest collapse into a count. */
const MAX_PILLS = 3

const FALLBACK_COLOR = 'stone'

type OptionType = 'select' | 'multiselect' | 'status'

interface OptionDisplayProps {
  type: OptionType
  value: unknown
  /** The property's name, to find its definition. Without it every pill is grey. */
  propertyName?: string
  className?: string
}

/** A multiselect holds names; one written as a select holds a bare name. */
function namesOf(value: unknown): string[] {
  const items = Array.isArray(value) ? value : [value]
  return items
    .filter((item): item is string | number => typeof item === 'string' || typeof item === 'number')
    .map((item) => String(item).trim())
    .filter(Boolean)
}

export const OptionCell = memo(function OptionCell({
  type,
  value,
  propertyName,
  className
}: OptionDisplayProps): React.JSX.Element {
  const { options, statusOptions } = usePropertyOptions(propertyName)
  const known = type === 'status' ? statusOptions : options
  const names = namesOf(value)
  const shown = type === 'multiselect' ? names.slice(0, MAX_PILLS) : names.slice(0, 1)
  const hidden = type === 'multiselect' ? names.length - shown.length : 0

  if (names.length === 0)
    return <span className={cn('text-muted-foreground/50', className)}>—</span>

  return (
    <div className={cn('flex flex-wrap items-center gap-1', className)}>
      {shown.map((name) => (
        <SelectChip
          key={name}
          value={name}
          color={known.find((option) => option.value === name)?.color ?? FALLBACK_COLOR}
        />
      ))}
      {hidden > 0 && <SelectChip value={`+${hidden}`} color={FALLBACK_COLOR} />}
    </div>
  )
})

interface OptionEditorCellProps {
  type: OptionType
  value: unknown
  propertyName?: string
  onChange: (value: unknown) => void
}

/** The note panel's picker, opened from the pill. */
export const OptionEditorCell = memo(function OptionEditorCell({
  type,
  value,
  propertyName,
  onChange
}: OptionEditorCellProps): React.JSX.Element {
  const { options, categories } = usePropertyOptions(propertyName)
  const names = namesOf(value)

  if (type === 'status') {
    return <StatusEditor value={names[0] ?? null} categories={categories} onChange={onChange} />
  }
  if (type === 'multiselect') {
    return <MultiselectEditor value={names} options={options} onChange={onChange} />
  }
  return <SelectEditor value={names[0] ?? null} options={options} onChange={onChange} />
})
