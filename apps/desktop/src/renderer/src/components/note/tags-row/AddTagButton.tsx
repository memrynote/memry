import { Plus } from 'lucide-react'
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
        'flex h-7 w-7 items-center justify-center',
        'rounded-full',
        'border-[1.5px] border-dashed border-stone-300',
        'text-stone-400',
        'transition-all duration-150',
        'hover:border-stone-400 hover:bg-stone-100 hover:text-stone-500',
        'focus:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2',
        'disabled:pointer-events-none disabled:opacity-50'
      )}
    >
      <Plus className="h-4 w-4" />
    </button>
  )
}
