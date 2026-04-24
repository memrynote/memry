import { memo, useCallback } from 'react'
import { cn } from '@/lib/utils'

interface HeadingItem {
  id: string
  level: number
  text: string
  position: number
}

interface NoteOutlineSidebarProps {
  headings: HeadingItem[]
  activeHeadingId?: string
  onHeadingClick?: (headingId: string) => void
}

export const NoteOutlineSidebar = memo(function NoteOutlineSidebar({
  headings,
  activeHeadingId,
  onHeadingClick
}: NoteOutlineSidebarProps) {
  const handleClick = useCallback(
    (headingId: string) => {
      onHeadingClick?.(headingId)
    },
    [onHeadingClick]
  )

  return (
    <div className="flex flex-col w-[200px] shrink-0 pt-12 pr-6 pb-10 gap-4">
      {/* Header */}
      <div className="flex items-center pb-3 gap-1.5 border-b border-[var(--border)]">
        <span className="text-[11px] tracking-[0.06em] uppercase text-text-tertiary font-sans font-semibold leading-3.5">
          Outline
        </span>
      </div>

      {/* Heading List */}
      {headings.length > 0 ? (
        <nav aria-label="Document outline" className="flex flex-col gap-1">
          {headings.map((heading) => {
            const isActive = heading.id === activeHeadingId
            const isSubHeading = heading.level >= 3

            return (
              <button
                key={heading.id}
                data-heading-id={heading.id}
                onClick={() => handleClick(heading.id)}
                className={cn(
                  'flex items-center rounded-md py-1.5 px-2 gap-2 text-left',
                  'transition-colors duration-150',
                  isSubHeading && 'pl-6',
                  !isActive && 'hover:bg-[var(--surface-active)]/50'
                )}
              >
                {/* Active indicator bar */}
                <div
                  className={cn(
                    'w-[3px] h-3.5 shrink-0 rounded-xs transition-colors duration-150',
                    isActive ? 'bg-sidebar-terracotta' : 'bg-transparent'
                  )}
                />
                <span
                  className={cn(
                    'text-[12px] font-sans leading-4 truncate',
                    isActive
                      ? 'text-foreground font-medium'
                      : isSubHeading
                        ? 'text-muted-foreground'
                        : 'text-text-secondary'
                  )}
                >
                  {heading.text}
                </span>
              </button>
            )
          })}
        </nav>
      ) : (
        <span className="text-[12px] text-text-tertiary font-sans">No headings yet</span>
      )}
    </div>
  )
})
