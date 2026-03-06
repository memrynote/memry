import { cn } from '@/lib/utils'
import { Smile } from 'lucide-react'

interface EmojiButtonProps {
  emoji: string | null
  onClick: () => void
  disabled?: boolean
}

export function EmojiButton({ emoji, onClick, disabled }: EmojiButtonProps) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-label={emoji ? `Change emoji: ${emoji}` : 'Choose emoji'}
      className={cn(
        'flex h-12 w-12 flex-shrink-0 items-center justify-center',
        'rounded-lg transition-colors duration-150',
        'hover:bg-stone-100',
        'focus:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2',
        'disabled:pointer-events-none disabled:opacity-50'
      )}
    >
      {emoji ? (
        <span className="text-[40px] leading-none">{emoji}</span>
      ) : (
        <div
          className={cn(
            'flex h-10 w-10 items-center justify-center',
            'rounded-lg border-2 border-dashed border-stone-300',
            'text-stone-400 transition-colors duration-150',
            'group-hover:border-stone-400 group-hover:text-stone-500'
          )}
        >
          <Smile className="h-5 w-5" />
        </div>
      )}
    </button>
  )
}
