import { useCallback } from 'react'
import { Check } from 'lucide-react'
import { cn } from '@/lib/utils'

interface CheckboxEditorProps {
  value: boolean
  onChange: (value: boolean) => void
}

export function CheckboxEditor({ value, onChange }: CheckboxEditorProps) {
  const handleClick = useCallback(() => {
    onChange(!value)
  }, [value, onChange])

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault()
        onChange(!value)
      }
    },
    [value, onChange]
  )

  return (
    <button
      type="button"
      role="checkbox"
      aria-checked={value}
      onClick={handleClick}
      onKeyDown={handleKeyDown}
      className={cn(
        'flex h-[18px] w-[18px] items-center justify-center',
        'rounded border-2 transition-all duration-150',
        value
          ? 'border-stone-900 bg-stone-900 text-white'
          : 'border-stone-300 bg-white hover:border-stone-400'
      )}
    >
      {value && <Check className="h-3 w-3" strokeWidth={3} />}
    </button>
  )
}
