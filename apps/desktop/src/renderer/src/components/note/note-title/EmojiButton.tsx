import { cn } from '@/lib/utils'
import { Smile } from '@/lib/icons'

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
        'flex items-center justify-center shrink-0 size-11',
        'rounded-xl bg-sidebar-terracotta/8',
        'transition-colors duration-150',
        'hover:bg-sidebar-terracotta/12',
        'focus:outline-none focus-visible:ring-1 focus-visible:ring-ring focus-visible:ring-offset-2',
        'disabled:pointer-events-none disabled:opacity-50'
      )}
    >
      {emoji ? (
        <span className="text-[22px] leading-7">{emoji}</span>
      ) : (
        <Smile className="h-5 w-5 text-text-tertiary" />
      )}
    </button>
  )
}
