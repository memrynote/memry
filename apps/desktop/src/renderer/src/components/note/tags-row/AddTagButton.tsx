import { Plus } from '@/lib/icons'
import { cn } from '@/lib/utils'

interface AddTagButtonProps {
  onClick: () => void
  disabled?: boolean
}

export function AddTagButton({ onClick, disabled }: AddTagButtonProps) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-label="Add tag"
      className={cn(
        'flex items-center justify-center',
        'rounded-full shrink-0 size-6',
        'border-[1.5px] border-dashed border-border',
        'text-text-tertiary',
        'transition-all duration-150',
        'hover:border-muted-foreground hover:text-muted-foreground',
        'focus:outline-none',
        'disabled:pointer-events-none disabled:opacity-50'
      )}
    >
      <Plus className="h-3 w-3" strokeWidth={2.5} />
    </button>
  )
}
