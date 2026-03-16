import { useState, useEffect, useCallback, useRef } from 'react'
import { Calendar, Flag, Folder } from 'lucide-react'
import { cn } from '@/lib/utils'

// ============================================================================
// TYPES
// ============================================================================

export type AutocompleteType = 'date' | 'priority' | 'project' | null

export interface AutocompleteOption {
  value: string
  label: string
  icon?: React.ReactNode
}

interface AutocompleteDropdownProps {
  type: AutocompleteType
  options: AutocompleteOption[]
  onSelect: (value: string) => void
  onClose: () => void
  className?: string
}

// ============================================================================
// AUTOCOMPLETE HEADER
// ============================================================================

const AutocompleteHeader = ({ type }: { type: AutocompleteType }): React.JSX.Element | null => {
  if (!type) return null

  const headers: Record<NonNullable<AutocompleteType>, { icon: React.ReactNode; label: string }> = {
    date: { icon: <Calendar className="size-3.5" />, label: 'Due Date' },
    priority: { icon: <Flag className="size-3.5" />, label: 'Priority' },
    project: { icon: <Folder className="size-3.5" />, label: 'Project' }
  }

  const header = headers[type]

  return (
    <div className="px-3 py-2 border-b border-border bg-muted/50 rounded-t-lg">
      <span className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground uppercase tracking-wide">
        {header.icon} {header.label}
      </span>
    </div>
  )
}

// ============================================================================
// AUTOCOMPLETE OPTION ITEM
// ============================================================================

interface OptionItemProps {
  option: AutocompleteOption
  isSelected: boolean
  showValue?: boolean
  onClick: () => void
}

const OptionItem = ({
  option,
  isSelected,
  showValue = true,
  onClick
}: OptionItemProps): React.JSX.Element => {
  return (
    <button
      type="button"
      onClick={onClick}
      onMouseDown={(e) => e.preventDefault()} // Prevent input blur
      className={cn(
        'w-full flex items-center px-3 py-2 text-sm',
        'transition-colors duration-100',
        showValue ? 'justify-between' : 'gap-2',
        isSelected ? 'bg-primary/10 text-primary' : 'hover:bg-muted/50'
      )}
      role="option"
      aria-selected={isSelected}
    >
      <div className="flex items-center gap-2">
        {option.icon && <span className="flex items-center justify-center w-4">{option.icon}</span>}
        {showValue && (
          <span className="font-mono text-xs text-muted-foreground">{option.value}</span>
        )}
        {!showValue && <span className="text-foreground">{option.label}</span>}
      </div>
      {showValue && <span className="text-foreground">{option.label}</span>}
    </button>
  )
}

// ============================================================================
// AUTOCOMPLETE DROPDOWN COMPONENT
// ============================================================================

export const AutocompleteDropdown = ({
  type,
  options,
  onSelect,
  onClose,
  className
}: AutocompleteDropdownProps): React.JSX.Element | null => {
  const [selectedIndex, setSelectedIndex] = useState(0)
  const listRef = useRef<HTMLDivElement>(null)

  // Reset selection when options change
  useEffect(() => {
    setSelectedIndex(0)
  }, [options])

  // Scroll selected item into view
  useEffect(() => {
    if (listRef.current) {
      const selectedElement = listRef.current.querySelector(`[data-index="${selectedIndex}"]`)
      if (selectedElement) {
        selectedElement.scrollIntoView({ block: 'nearest' })
      }
    }
  }, [selectedIndex])

  // Keyboard navigation
  const handleKeyDown = useCallback(
    (e: KeyboardEvent) => {
      if (options.length === 0) return

      switch (e.key) {
        case 'ArrowDown':
          e.preventDefault()
          setSelectedIndex((prev) => Math.min(prev + 1, options.length - 1))
          break
        case 'ArrowUp':
          e.preventDefault()
          setSelectedIndex((prev) => Math.max(prev - 1, 0))
          break
        case 'Enter':
        case 'Tab':
          e.preventDefault()
          if (options[selectedIndex]) {
            onSelect(options[selectedIndex].value)
          }
          break
        case 'Escape':
          e.preventDefault()
          onClose()
          break
      }
    },
    [options, selectedIndex, onSelect, onClose]
  )

  // Add/remove keyboard listener
  useEffect(() => {
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [handleKeyDown])

  // Don't render if no options
  if (options.length === 0) return null

  return (
    <div
      className={cn(
        'absolute top-full left-0 mt-1 min-w-[16rem] w-fit',
        'bg-popover rounded-sm shadow-lg border border-border',
        'z-50 overflow-hidden',
        'animate-in fade-in-0 zoom-in-95 duration-100',
        className
      )}
      role="listbox"
      aria-label={`${type} options`}
    >
      {/* Header */}
      <AutocompleteHeader type={type} />

      {/* Options */}
      <div ref={listRef} className="py-1 max-h-48 overflow-y-auto">
        {options.map((option, index) => (
          <div key={option.value} data-index={index}>
            <OptionItem
              option={option}
              isSelected={index === selectedIndex}
              showValue={type !== 'project'}
              onClick={() => onSelect(option.value)}
            />
          </div>
        ))}
      </div>
    </div>
  )
}

export default AutocompleteDropdown
