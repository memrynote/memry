import { useRef, useEffect } from 'react'
import { FilterSearchHeader } from '@/components/ui/filter-search-header'
import { usePickerContext } from './types'

interface PickerSearchProps {
  placeholder?: string
  leading?: React.ReactNode
  className?: string
}

export function PickerSearch({
  placeholder = 'Search...',
  leading,
  className
}: PickerSearchProps): React.JSX.Element {
  const { searchQuery, onSearchChange, open } = usePickerContext()
  const initialRender = useRef(true)

  useEffect(() => {
    if (initialRender.current) {
      initialRender.current = false
      return
    }
    if (!open) onSearchChange('')
  }, [open, onSearchChange])

  return (
    <FilterSearchHeader
      value={searchQuery}
      onChange={onSearchChange}
      placeholder={placeholder}
      leading={leading}
      className={className}
    />
  )
}
