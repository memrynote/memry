import { cn } from '@/lib/utils'
import { Smile } from '@/lib/icons'
import { isIconValue, parseIconName } from './emoji-icon-utils'
import { HugeIconByName } from '@/lib/hugeicon-renderer'

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
        'focus:outline-none',
        'disabled:pointer-events-none disabled:opacity-50'
      )}
    >
      {emoji && isIconValue(emoji) ? (
        <HugeIconByName name={parseIconName(emoji)} className="h-5 w-5 text-text-tertiary" />
      ) : emoji ? (
        <span className="text-[22px] leading-7">{emoji}</span>
      ) : (
        <Smile className="h-5 w-5 text-text-tertiary" />
      )}
    </button>
  )
}
