import { useState, useRef, useCallback, useEffect } from 'react'
import { cn } from '@/lib/utils'
import { useClickOutside } from '../note-title/use-click-outside'
import { PropertyType, PROPERTY_TYPE_CONFIG, PROPERTY_TYPES, NewProperty } from './types'

interface AddPropertyPopupProps {
  isOpen: boolean
  onClose: () => void
  onAdd: (property: NewProperty) => void
}

export function AddPropertyPopup({ isOpen, onClose, onAdd }: AddPropertyPopupProps) {
  const popupRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const [name, setName] = useState('')
  const [type, setType] = useState<PropertyType>('text')
  const [isTypeOpen, setIsTypeOpen] = useState(false)

  useClickOutside(popupRef, onClose, isOpen)

  // Focus input when popup opens
  useEffect(() => {
    if (isOpen && inputRef.current) {
      inputRef.current.focus()
    }
  }, [isOpen])

  // Reset state when popup closes
  useEffect(() => {
    if (!isOpen) {
      setName('')
      setType('text')
      setIsTypeOpen(false)
    }
  }, [isOpen])

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault()
        onClose()
      }
    },
    [onClose]
  )

  const handleAdd = useCallback(() => {
    if (name.trim()) {
      onAdd({ name: name.trim(), type })
      onClose()
    }
  }, [name, type, onAdd, onClose])

  const handleTypeSelect = useCallback((selectedType: PropertyType) => {
    setType(selectedType)
    setIsTypeOpen(false)
  }, [])

  if (!isOpen) return null

  const selectedConfig = PROPERTY_TYPE_CONFIG[type]

  return (
    <div
      ref={popupRef}
      role="dialog"
      aria-modal="true"
      aria-label="Add property"
      onKeyDown={handleKeyDown}
      className={cn(
        'absolute left-0 top-full z-50 mt-2',
        'w-[280px]',
        'rounded-xl border border-stone-200 bg-white',
        'shadow-lg',
        'p-4',
        'animate-in fade-in-0 zoom-in-95 duration-150'
      )}
    >
      {/* Title */}
      <div className="mb-4 text-sm font-medium text-stone-900">
        Add property
      </div>

      {/* Divider */}
      <div className="mb-4 border-t border-stone-200" />

      {/* Property name */}
      <div className="mb-4">
        <label className="mb-1.5 block text-xs font-medium text-stone-500">
          Property name
        </label>
        <input
          ref={inputRef}
          type="text"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="Enter name..."
          className={cn(
            'w-full rounded-lg px-3 py-2',
            'text-sm text-stone-900',
            'bg-white border border-stone-300',
            'placeholder:text-stone-400',
            'outline-none',
            'focus:border-stone-400 focus:ring-1 focus:ring-stone-400'
          )}
        />
      </div>

      {/* Property type */}
      <div className="mb-4">
        <label className="mb-1.5 block text-xs font-medium text-stone-500">
          Property type
        </label>
        <div className="relative">
          <button
            type="button"
            onClick={() => setIsTypeOpen(!isTypeOpen)}
            className={cn(
              'flex w-full items-center gap-2',
              'rounded-lg px-3 py-2',
              'text-sm text-stone-900 text-left',
              'bg-white border border-stone-300',
              'outline-none',
              'hover:border-stone-400',
              isTypeOpen && 'border-stone-400 ring-1 ring-stone-400'
            )}
          >
            <span>{selectedConfig.icon}</span>
            <span>{selectedConfig.label}</span>
          </button>

          {isTypeOpen && (
            <div
              className={cn(
                'absolute left-0 top-full z-10 mt-1',
                'w-full max-h-48 overflow-auto',
                'rounded-lg border border-stone-200 bg-white',
                'shadow-lg',
                'animate-in fade-in-0 zoom-in-95 duration-100'
              )}
            >
              {PROPERTY_TYPES.map((propType) => {
                const config = PROPERTY_TYPE_CONFIG[propType]
                return (
                  <button
                    key={propType}
                    type="button"
                    onClick={() => handleTypeSelect(propType)}
                    className={cn(
                      'flex w-full items-center gap-2',
                      'px-3 py-2 text-left text-sm',
                      'transition-colors duration-100',
                      type === propType
                        ? 'bg-stone-100 text-stone-900'
                        : 'text-stone-700 hover:bg-stone-50'
                    )}
                  >
                    <span>{config.icon}</span>
                    <span>{config.label}</span>
                  </button>
                )
              })}
            </div>
          )}
        </div>
      </div>

      {/* Actions */}
      <div className="flex justify-end gap-2">
        <button
          type="button"
          onClick={onClose}
          className={cn(
            'rounded-lg px-3 py-1.5',
            'text-sm text-stone-600',
            'transition-colors duration-150',
            'hover:bg-stone-100'
          )}
        >
          Cancel
        </button>
        <button
          type="button"
          onClick={handleAdd}
          disabled={!name.trim()}
          className={cn(
            'rounded-lg px-3 py-1.5',
            'text-sm font-medium text-white',
            'bg-stone-900',
            'transition-colors duration-150',
            'hover:bg-stone-800',
            'disabled:opacity-50 disabled:cursor-not-allowed'
          )}
        >
          Add
        </button>
      </div>
    </div>
  )
}
