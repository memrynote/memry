import { useContext } from 'react'
import { cn } from '@/lib/utils'
import { PickerLabelFilterContext, usePickerContextOptional } from './types'

interface PickerSeparatorProps {
  className?: string
}

export function PickerSeparator({ className }: PickerSeparatorProps): React.JSX.Element | null {
  const filtering = useContext(PickerLabelFilterContext)
  const searchQuery = usePickerContextOptional()?.searchQuery ?? ''
  if (filtering && searchQuery.trim()) return null
  return <div data-slot="picker-separator" className={cn('-mx-1 my-1 h-px bg-border', className)} />
}
