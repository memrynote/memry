import { useState, useCallback, useRef, useEffect, memo } from 'react'
import { cn } from '@/lib/utils'
import { format, parseISO, isValid } from 'date-fns'

export interface HeadingItem {
  id: string
  level: number
  text: string
  position: number
}

export interface DocumentStats {
  wordCount: number
  characterCount: number
  createdAt: string | Date | null
  modifiedAt: string | Date | null
}

export interface OutlineInfoPanelProps {
  headings?: HeadingItem[]
  onHeadingClick?: (headingId: string) => void
  className?: string
  activeHeadingId?: string
  stats?: DocumentStats
}

function getLineWidth(level: number): number {
  switch (level) {
    case 1:
      return 24
    case 2:
      return 16
    case 3:
    default:
      return 10
  }
}

function formatStatsDate(date: string | Date | null): string {
  if (!date) return '—'
  try {
    const dateObj = typeof date === 'string' ? parseISO(date) : date
    if (!isValid(dateObj)) return '—'
    return format(dateObj, 'MMM d, yyyy')
  } catch {
    return '—'
  }
}

function formatReadingTime(wordCount: number): string {
  if (wordCount === 0) return '0 min read'
  const minutes = Math.ceil(wordCount / 200)
  return minutes === 1 ? '1 min read' : `${minutes} min read`
}

const FADE_DURATION = 100
const PINNED_LEAVE_DELAY = 200
const HOVER_LEAVE_DELAY = 150

export const OutlineInfoPanel = memo(function OutlineInfoPanel({
  headings = [],
  onHeadingClick,
  className,
  activeHeadingId,
  stats
}: OutlineInfoPanelProps) {
  const [isExpanded, setIsExpanded] = useState(false)
  const [isPinned, setIsPinned] = useState(false)
  const [isFadingOut, setIsFadingOut] = useState(false)
  const containerRef = useRef<HTMLDivElement>(null)
  const popupRef = useRef<HTMLDivElement>(null)
  const delayRef = useRef<NodeJS.Timeout | null>(null)
  const fadeRef = useRef<NodeJS.Timeout | null>(null)

  const clearAllTimeouts = useCallback(() => {
    if (delayRef.current) {
      clearTimeout(delayRef.current)
      delayRef.current = null
    }
    if (fadeRef.current) {
      clearTimeout(fadeRef.current)
      fadeRef.current = null
    }
  }, [])

  const handleMouseEnter = useCallback(() => {
    clearAllTimeouts()
    setIsFadingOut(false)
    setIsExpanded(true)
  }, [clearAllTimeouts])

  const handleMouseLeave = useCallback(() => {
    const delay = isPinned ? PINNED_LEAVE_DELAY : HOVER_LEAVE_DELAY
    delayRef.current = setTimeout(() => {
      setIsFadingOut(true)
      fadeRef.current = setTimeout(() => {
        setIsExpanded(false)
        setIsFadingOut(false)
        setIsPinned(false)
      }, FADE_DURATION)
    }, delay)
  }, [isPinned])

  const handleClick = useCallback(
    (headingId: string) => {
      clearAllTimeouts()
      setIsPinned(true)
      setIsFadingOut(false)
      onHeadingClick?.(headingId)
    },
    [onHeadingClick, clearAllTimeouts]
  )

  useEffect(() => {
    if (isExpanded && !isFadingOut && activeHeadingId && popupRef.current) {
      requestAnimationFrame(() => {
        const activeElement = popupRef.current?.querySelector(
          `[data-heading-id="${activeHeadingId}"]`
        )
        if (activeElement) {
          activeElement.scrollIntoView({ block: 'center', behavior: 'instant' })
        }
      })
    }
  }, [isExpanded, isFadingOut, activeHeadingId])

  useEffect(() => {
    return () => clearAllTimeouts()
  }, [clearAllTimeouts])

  if (headings.length === 0) {
    return null
  }

  const verticalLineHeight = headings.length > 0 ? Math.max(0, (headings.length - 1) * 14 + 4) : 0
  const hasOutline = headings.length > 0

  return (
    <div
      ref={containerRef}
      className={cn(
        'outline-indicator',
        'absolute right-4 top-32',
        'hidden md:block z-40',
        className
      )}
      onMouseEnter={handleMouseEnter}
      onMouseLeave={handleMouseLeave}
    >
      {!isExpanded ? (
        <div className="flex items-start gap-0 cursor-pointer">
          {headings.length > 0 && (
            <div className="flex flex-col items-end gap-2.5 py-1">
              {headings.map((heading) => {
                const isActive = heading.id === activeHeadingId
                const width = getLineWidth(heading.level)

                return (
                  <div
                    key={heading.id}
                    className="outline-line rounded-full transition-all duration-200"
                    style={{
                      width: `${width}px`,
                      height: isActive ? '2px' : '1px',
                      backgroundColor: isActive
                        ? 'var(--sidebar-terracotta)'
                        : 'var(--text-tertiary)',
                      opacity: isActive ? 1 : 0.4
                    }}
                  />
                )
              })}
            </div>
          )}

          {headings.length > 0 && (
            <div
              className="vertical-connector ml-1.5 mt-1"
              style={{
                width: '1px',
                height: `${verticalLineHeight}px`,
                background:
                  'linear-gradient(to bottom, transparent 0%, rgb(214, 211, 209) 8%, rgb(214, 211, 209) 92%, transparent 100%)'
              }}
              aria-hidden="true"
            />
          )}
        </div>
      ) : (
        <div
          ref={popupRef}
          className={cn(
            'bg-background border border-border/10',
            'shadow-lg rounded-[10px]',
            'min-w-[240px] max-w-[300px]',
            !isFadingOut && 'animate-in fade-in-0 zoom-in-95 duration-150'
          )}
          style={
            isFadingOut
              ? {
                  opacity: 0,
                  transform: 'scale(0.98)',
                  transition: `opacity ${FADE_DURATION}ms ease, transform ${FADE_DURATION}ms ease`
                }
              : undefined
          }
        >
          <div className="py-3 px-3.5 flex flex-col gap-2">
            <div className="flex items-center gap-1.5">
              <span className="text-[11px] tracking-[0.05em] uppercase text-text-tertiary font-medium leading-3.5">
                Outline
              </span>
            </div>

            {hasOutline ? (
              <nav
                aria-label="Document outline"
                className="flex flex-col gap-0.5 max-h-[50vh] overflow-y-auto"
              >
                {headings.map((heading) => {
                  const isActive = heading.id === activeHeadingId
                  const isSubHeading = heading.level >= 3

                  return (
                    <button
                      key={heading.id}
                      data-heading-id={heading.id}
                      onClick={() => handleClick(heading.id)}
                      className={cn(
                        'flex items-center rounded-sm py-[3px] px-1.5 gap-1.5 text-left',
                        'transition-colors duration-150',
                        'focus:outline-none',
                        !isActive && 'hover:bg-[var(--surface-active)]/50'
                      )}
                    >
                      <div
                        className={cn(
                          'w-0.5 h-3 shrink-0 rounded-[1px] transition-colors duration-150',
                          isActive ? 'bg-sidebar-terracotta' : 'bg-transparent'
                        )}
                      />
                      <span
                        className={cn(
                          'text-xs font-sans leading-4 truncate',
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
              <span className="text-xs text-text-tertiary">No headings</span>
            )}

            {stats && (
              <>
                <div className="h-px bg-border/50" />
                <div className="flex items-center justify-between">
                  <span className="text-[11px] text-text-tertiary leading-3.5">
                    {stats.wordCount.toLocaleString()} words
                  </span>
                  <span className="text-[11px] text-text-tertiary leading-3.5">
                    {formatReadingTime(stats.wordCount)}
                  </span>
                </div>
                {(stats.createdAt || stats.modifiedAt) && (
                  <div className="flex flex-col gap-0.5">
                    {stats.createdAt && (
                      <div className="flex items-center justify-between">
                        <span className="text-[11px] text-text-tertiary leading-3.5">Created</span>
                        <span className="text-[11px] text-text-tertiary leading-3.5">
                          {formatStatsDate(stats.createdAt)}
                        </span>
                      </div>
                    )}
                    {stats.modifiedAt && (
                      <div className="flex items-center justify-between">
                        <span className="text-[11px] text-text-tertiary leading-3.5">Modified</span>
                        <span className="text-[11px] text-text-tertiary leading-3.5">
                          {formatStatsDate(stats.modifiedAt)}
                        </span>
                      </div>
                    )}
                  </div>
                )}
              </>
            )}
          </div>
        </div>
      )}
    </div>
  )
})
