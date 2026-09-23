import { useId, useMemo, useState } from 'react'
import type { NoteLink } from '@memry/contracts/notes-api'
import { cn } from '@/lib/utils'
import { ArrowUpRight, ChevronDown } from '@/lib/icons'
import { useT } from '@memry/i18n/renderer'

interface OutgoingLinksSectionProps {
  links: NoteLink[]
  initialCount?: number
  onLinkClick: (targetTitle: string) => void
}

export function OutgoingLinksSection({
  links,
  initialCount = 5,
  onLinkClick
}: OutgoingLinksSectionProps) {
  const { t } = useT('notes')
  const contentId = useId()
  const [isCollapsed, setIsCollapsed] = useState(false)
  const [visibleCount, setVisibleCount] = useState(initialCount)

  const sortedLinks = useMemo(
    () => [...links].sort((a, b) => a.targetTitle.localeCompare(b.targetTitle)),
    [links]
  )

  if (sortedLinks.length === 0) return null

  const remainingCount = sortedLinks.length - visibleCount

  return (
    <section className="flex flex-col gap-1" aria-label={t('outgoingLinks.sectionAria')}>
      <button
        type="button"
        onClick={() => setIsCollapsed(!isCollapsed)}
        className={cn(
          'flex items-center gap-1.5 self-start rounded',
          'cursor-pointer hover:opacity-80 transition-opacity',
          'focus:outline-none focus-visible:ring-1 focus-visible:ring-border'
        )}
        aria-expanded={!isCollapsed}
        aria-controls={contentId}
      >
        <ChevronDown
          className={cn(
            'h-3 w-3 text-text-tertiary flex-shrink-0 transition-transform duration-150',
            isCollapsed && '-rotate-90'
          )}
          aria-hidden="true"
        />
        <ArrowUpRight className="mirror-rtl h-3.5 w-3.5 text-text-tertiary" aria-hidden="true" />
        <span className="text-xs/4 font-medium text-text-tertiary">
          {t('outgoingLinks.summary', { count: sortedLinks.length })}
        </span>
      </button>

      {!isCollapsed && (
        <div id={contentId}>
          <ul className="flex flex-col">
            {sortedLinks.slice(0, visibleCount).map((link) => {
              const resolved = link.targetId !== null
              return (
                <li key={link.targetTitle}>
                  <button
                    type="button"
                    onClick={() => onLinkClick(link.targetTitle)}
                    className={cn(
                      'flex w-full min-w-0 items-center gap-1.5 px-1.5 py-1',
                      'rounded text-start cursor-pointer',
                      'hover:bg-surface-active/40 transition-colors duration-150',
                      'focus:outline-none focus-visible:ring-1 focus-visible:ring-border'
                    )}
                  >
                    <span
                      className={cn(
                        'truncate text-[13px]/4 font-medium',
                        resolved
                          ? 'text-text-bright'
                          : 'text-text-tertiary underline decoration-dashed decoration-1 underline-offset-2'
                      )}
                    >
                      {link.targetTitle}
                    </span>
                    {!resolved && (
                      <>
                        {' '}
                        <span className="flex-shrink-0 text-[11px] text-text-tertiary">
                          {t('outgoingLinks.unresolved')}
                        </span>
                      </>
                    )}
                  </button>
                </li>
              )
            })}
          </ul>

          {remainingCount > 0 && (
            <button
              type="button"
              onClick={() => setVisibleCount((prev) => prev + initialCount)}
              className={cn(
                'w-full py-1.5 mt-0.5 rounded',
                'text-[11px] text-text-tertiary hover:text-muted-foreground',
                'transition-colors duration-150 cursor-pointer',
                'focus:outline-none focus-visible:ring-1 focus-visible:ring-border'
              )}
              aria-label={t('outgoingLinks.showMore', { count: remainingCount })}
            >
              {t('outgoingLinks.more', { count: remainingCount })}
            </button>
          )}
        </div>
      )}
    </section>
  )
}
