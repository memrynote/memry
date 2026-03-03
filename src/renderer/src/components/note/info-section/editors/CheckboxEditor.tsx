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
        'flex h-4 w-4 items-center justify-center shrink-0',
        'rounded border-[1.5px] transition-colors duration-150',
        value
          ? 'border-primary bg-primary text-primary-foreground'
          : 'border-muted-foreground/30 bg-background/50'
      )}
    >
      {value && <Check className="h-3 w-3" strokeWidth={3} />}
    </button>
  )
}
