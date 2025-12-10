import { useRef, useCallback, useEffect } from 'react'
import { GripVertical } from 'lucide-react'
import { cn } from '@/lib/utils'
import { useClickOutside } from '../note-title/use-click-outside'
import { PropertyType, PROPERTY_TYPE_CONFIG, PROPERTY_TYPES, NewProperty } from './types'

interface AddPropertyPopupProps {
  isOpen: boolean
  onClose: () => void
  onAdd: (property: NewProperty) => void
  position?: { top: number; left: number }
}

export function AddPropertyPopup({ isOpen, onClose, onAdd, position }: AddPropertyPopupProps) {
  const popupRef = useRef<HTMLDivElement>(null)

  useClickOutside(popupRef, onClose, isOpen)

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault()
        onClose()
      }
    },
    [onClose]
  )

  const handleTypeSelect = useCallback((type: PropertyType) => {
    // Get the default label for this type as the property name
    const config = PROPERTY_TYPE_CONFIG[type]
    onAdd({ name: config.label, type })
    onClose()
  }, [onAdd, onClose])

  // Focus first item when opened
  useEffect(() => {
    if (isOpen && popupRef.current) {
      const firstButton = popupRef.current.querySelector('button[role="option"]') as HTMLButtonElement
      firstButton?.focus()
    }
  }, [isOpen])

  if (!isOpen) return null

  return (
    <div
      ref={popupRef}
      role="listbox"
      aria-label="Property types"
      onKeyDown={handleKeyDown}
      className={cn(
        'fixed z-[9999]',
        'w-[240px] max-h-[400px] overflow-y-auto',
        'rounded-lg border border-stone-200 bg-white',
        'shadow-lg',
        'py-1',
        'animate-in fade-in-0 zoom-in-95 duration-150'
      )}
      style={position ? { top: position.top, left: position.left } : undefined}
    >
      {/* Header */}
      <div className="flex items-center gap-2 px-3 py-2 border-b border-stone-100">
        <GripVertical className="h-4 w-4 text-stone-300" />
        <span className="text-sm text-stone-400">Add property</span>
      </div>

      {/* Type section header */}
      <div className="px-3 py-2 text-[11px] font-medium text-stone-400 uppercase tracking-wide">
        Type
      </div>

      {/* Property types list */}
      {PROPERTY_TYPES.map((propType) => {
        const config = PROPERTY_TYPE_CONFIG[propType]
        const IconComponent = config.icon

        return (
          <button
            key={propType}
            type="button"
            role="option"
            aria-selected={false}
            onClick={() => handleTypeSelect(propType)}
            className={cn(
              'flex w-full items-center gap-3',
              'px-3 py-2 text-left text-sm',
              'transition-colors duration-100',
              'text-stone-700 hover:bg-stone-50',
              'focus:bg-stone-100 focus:outline-none'
            )}
          >
            <span className="text-stone-400">
              <IconComponent className="h-4 w-4" />
            </span>
            <span>{config.label}</span>
          </button>
        )
      })}
    </div>
  )
}
