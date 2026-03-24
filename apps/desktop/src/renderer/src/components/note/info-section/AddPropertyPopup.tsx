import { useRef, useCallback, useState } from 'react'
import { cn } from '@/lib/utils'
import { useClickOutside } from '../note-title/use-click-outside'
import { PropertyType, PROPERTY_TYPE_CONFIG, PROPERTY_TYPES, NewProperty } from './types'

interface AddPropertyPopupProps {
  isOpen: boolean
  onClose: () => void
  onAdd: (property: NewProperty) => void
  position?: { top: number; left: number }
  existingPropertyNames?: string[]
}

const EMPTY_PROPERTY_NAMES: string[] = []

export function AddPropertyPopup({
  isOpen,
  onClose,
  onAdd,
  position,
  existingPropertyNames = EMPTY_PROPERTY_NAMES
}: AddPropertyPopupProps) {
  const popupRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const [propertyName, setPropertyName] = useState('')

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

  const handleInputKeyDown = useCallback((e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') {
      e.preventDefault()
      // Focus the first type button when Enter is pressed
      const firstButton = popupRef.current?.querySelector(
        'button[role="option"]'
      ) as HTMLButtonElement
      firstButton?.focus()
    }
  }, [])

  const handleTypeSelect = useCallback(
    (type: PropertyType) => {
      const config = PROPERTY_TYPE_CONFIG[type]
      // Use custom name if provided, otherwise use type label
      const baseName = propertyName.trim() || config.label
      onAdd({ name: baseName, type })
      onClose()
    },
    [onAdd, onClose, propertyName]
  )

  const focusInput = useCallback((node: HTMLInputElement | null) => {
    inputRef.current = node
    node?.focus()
  }, [])

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
        'rounded-md border border-stone-200 bg-white dark:border-stone-700 dark:bg-stone-900',
        'shadow-lg',
        'py-1',
        'animate-in fade-in-0 zoom-in-95 duration-150'
      )}
      style={position ? { top: position.top, left: position.left } : undefined}
    >
      {/* Property name input */}
      <div className="px-3 py-2 border-b border-stone-100 dark:border-stone-800">
        <input
          ref={focusInput}
          type="text"
          value={propertyName}
          onChange={(e) => setPropertyName(e.target.value)}
          onKeyDown={handleInputKeyDown}
          placeholder="Property name"
          className={cn(
            'w-full px-2 py-1.5 text-sm',
            'bg-stone-50 dark:bg-stone-800',
            'border border-stone-200 dark:border-stone-700 rounded',
            'placeholder:text-stone-400 dark:placeholder:text-stone-500',
            'focus:outline-none'
          )}
          aria-label="Property name"
        />
      </div>

      {/* Type section header */}
      <div className="px-3 py-2 text-[11px] font-medium text-stone-400 dark:text-stone-500 uppercase tracking-wide">
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
              'text-stone-700 dark:text-stone-300 hover:bg-stone-50 dark:hover:bg-stone-800',
              'focus:bg-stone-100 dark:focus:bg-stone-800 focus:outline-none'
            )}
          >
            <span className="text-stone-400 dark:text-stone-500">
              <IconComponent className="h-4 w-4" />
            </span>
            <span>{config.label}</span>
          </button>
        )
      })}
    </div>
  )
}
