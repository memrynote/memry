import { memo } from 'react'
import { Link, Play, Globe } from '@/lib/icons'
import { cn } from '@/lib/utils'
import type { PasteLinkOption } from './hooks/use-paste-link-menu'

const OPTION_CONFIG: Record<PasteLinkOption, { label: string; icon: typeof Link }> = {
  url: { label: 'URL', icon: Globe },
  mention: { label: 'Mention', icon: Link },
  embed: { label: 'Embed video', icon: Play }
}

interface PasteLinkMenuProps {
  isOpen: boolean
  position: { x: number; y: number }
  options: PasteLinkOption[]
  selectedIndex: number
  onSelect: (option: PasteLinkOption) => void
}

export const PasteLinkMenu = memo(
  ({ isOpen, position, options, selectedIndex, onSelect }: PasteLinkMenuProps) => {
    if (!isOpen) return null

    return (
      <div
        data-paste-link-menu
        className="absolute z-50 min-w-[160px] rounded-lg border border-border bg-popover p-1 shadow-md animate-in fade-in-0 zoom-in-95"
        style={{ left: position.x, top: position.y }}
      >
        <p className="px-2 py-1 text-[11px] text-muted-foreground/60">Paste as</p>
        {options.map((option, index) => {
          const { label, icon: Icon } = OPTION_CONFIG[option]
          return (
            <button
              key={option}
              type="button"
              className={cn(
                'flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-sm',
                'transition-colors cursor-pointer',
                index === selectedIndex
                  ? 'bg-accent text-accent-foreground'
                  : 'text-foreground hover:bg-accent/50'
              )}
              onMouseDown={(e) => {
                e.preventDefault()
                onSelect(option)
              }}
            >
              <Icon className="size-4 text-muted-foreground" />
              {label}
            </button>
          )
        })}
      </div>
    )
  }
)

PasteLinkMenu.displayName = 'PasteLinkMenu'
