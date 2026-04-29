import { memo } from 'react'
import { Link, Play, Globe } from '@/lib/icons'
import { cn } from '@/lib/utils'
import type { PasteLinkOption } from './hooks/use-paste-link-menu'
import { useT } from '@memry/i18n/renderer'

const OPTION_CONFIG: Record<PasteLinkOption, { icon: typeof Link }> = {
  url: { icon: Globe },
  mention: { icon: Link },
  embed: { icon: Play }
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
    const { t } = useT('notes')

    if (!isOpen) return null

    return (
      <div
        data-paste-link-menu
        className="absolute z-50 min-w-[160px] rounded-lg border border-border bg-popover p-1 shadow-md animate-in fade-in-0 zoom-in-95"
        style={{ left: position.x, top: position.y }}
      >
        <p className="px-2 py-1 text-[11px] text-muted-foreground/60">
          {t('menus.pasteLink.title')}
        </p>
        {options.map((option, index) => {
          const { icon: Icon } = OPTION_CONFIG[option]
          const label =
            option === 'url'
              ? t('menus.pasteLink.url')
              : option === 'mention'
                ? t('menus.pasteLink.mention')
                : t('menus.pasteLink.embedVideo')
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
