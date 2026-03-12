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
        'flex items-center justify-center',
        'rounded-full shrink-0 size-6',
        'border-[1.5px] border-dashed border-[#C8C3BA]',
        'text-[#B5B0A6]',
        'transition-all duration-150',
        'hover:border-[#8A857A] hover:text-[#8A857A]',
        'focus:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2',
        'disabled:pointer-events-none disabled:opacity-50'
      )}
    >
      <Plus className="h-3 w-3" strokeWidth={2.5} />
    </button>
  )
}
