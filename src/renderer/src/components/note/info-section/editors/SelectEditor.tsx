import { useState, useRef, useCallback } from 'react'
import { ChevronDown, Check } from 'lucide-react'
import { cn } from '@/lib/utils'
import { useClickOutside } from '../../note-title/use-click-outside'

interface SelectEditorProps {
  value: string | null
  options: string[]
  onChange: (value: string | null) => void
  onBlur?: () => void
  placeholder?: string
}

export function SelectEditor({
  value,
  options,
  onChange,
  onBlur,
  placeholder = 'Select...'
}: SelectEditorProps) {
  const [isOpen, setIsOpen] = useState(false)
  const containerRef = useRef<HTMLDivElement>(null)

  useClickOutside(
    containerRef,
    () => {
      setIsOpen(false)
      onBlur?.()
    },
    isOpen
  )

  const handleSelect = useCallback(
    (option: string) => {
      onChange(option === value ? null : option)
      setIsOpen(false)
      onBlur?.()
    },
    [value, onChange, onBlur]
  )

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault()
        setIsOpen(false)
        onBlur?.()
      }
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault()
        setIsOpen(!isOpen)
      }
    },
    [isOpen, onBlur]
  )

  return (
    <div ref={containerRef} className="relative">
      <button
        type="button"
        onClick={() => setIsOpen(!isOpen)}
        onKeyDown={handleKeyDown}
        className={cn(
          'flex w-full items-center justify-between gap-2',
          'rounded px-2 py-1',
          'text-[13px] text-left',
          'bg-white border border-stone-300',
          'outline-none',
          'hover:border-stone-400',
          isOpen && 'border-stone-400 ring-1 ring-stone-400'
        )}
      >
        <span className={value ? 'text-stone-900' : 'text-stone-400'}>{value || placeholder}</span>
        <ChevronDown
          className={cn(
            'h-3.5 w-3.5 text-stone-400 transition-transform duration-150',
            isOpen && 'rotate-180'
          )}
        />
      </button>

      {isOpen && (
        <div
          className={cn(
            'absolute left-0 top-full z-50 mt-1',
            'min-w-full max-h-48 overflow-auto',
            'rounded-lg border border-stone-200 bg-white',
            'shadow-lg',
            'animate-in fade-in-0 zoom-in-95 duration-100'
          )}
        >
          {options.map((option) => (
            <button
              key={option}
              type="button"
              onClick={() => handleSelect(option)}
              className={cn(
                'flex w-full items-center justify-between gap-2',
                'px-3 py-2 text-left text-[13px]',
                'transition-colors duration-100',
                value === option
                  ? 'bg-stone-100 text-stone-900'
                  : 'text-stone-700 hover:bg-stone-50'
              )}
            >
              {option}
              {value === option && <Check className="h-3.5 w-3.5 text-stone-600" />}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}
