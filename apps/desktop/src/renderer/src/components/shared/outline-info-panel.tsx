import { useState, useCallback, useRef, useEffect, memo } from 'react'
import { cn } from '@/lib/utils'
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs'
import { DocumentInfoTab, type DocumentStats } from './document-info-tab'

export interface HeadingItem {
  id: string
  level: number
  text: string
  position: number
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
  const [activeTab, setActiveTab] = useState<string>('outline')
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
    if (
      isExpanded &&
      !isFadingOut &&
      activeHeadingId &&
      popupRef.current &&
      activeTab === 'outline'
    ) {
      requestAnimationFrame(() => {
        const activeElement = popupRef.current?.querySelector(
          `[data-heading-id="${activeHeadingId}"]`
        )
        if (activeElement) {
          activeElement.scrollIntoView({ block: 'center', behavior: 'instant' })
        }
      })
    }
  }, [isExpanded, isFadingOut, activeHeadingId, activeTab])

  useEffect(() => {
    return () => clearAllTimeouts()
  }, [clearAllTimeouts])

  if (headings.length === 0 && !stats) {
    return null
  }

  const verticalLineHeight = headings.length > 0 ? Math.max(0, (headings.length - 1) * 14 + 4) : 0
  const hasOutline = headings.length > 0
  const hasInfo = !!stats

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
                      backgroundColor: isActive ? '#C45D3E' : '#B5B0A6',
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

          {headings.length === 0 && hasInfo && (
            <div
              className="w-2 h-2 rounded-full bg-stone-400/40 hover:bg-stone-400/60 transition-colors"
              aria-label="Document info available"
            />
          )}
        </div>
      ) : (
        <div
          ref={popupRef}
          className={cn(
            'bg-background border border-border',
            'shadow-lg rounded-md',
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
          <Tabs value={activeTab} onValueChange={setActiveTab} className="w-full">
            <TabsList className="w-full h-8 p-0.5 bg-surface rounded-t-lg rounded-b-none">
              <TabsTrigger
                value="outline"
                className={cn(
                  'flex-1 h-7 text-xs font-medium rounded-md',
                  'data-[state=active]:bg-background',
                  'data-[state=active]:shadow-sm',
                  !hasOutline && 'opacity-50 cursor-not-allowed'
                )}
                disabled={!hasOutline}
              >
                Outline
              </TabsTrigger>
              <TabsTrigger
                value="info"
                className={cn(
                  'flex-1 h-7 text-xs font-medium rounded-md',
                  'data-[state=active]:bg-background',
                  'data-[state=active]:shadow-sm',
                  !hasInfo && 'opacity-50 cursor-not-allowed'
                )}
                disabled={!hasInfo}
              >
                Info
              </TabsTrigger>
            </TabsList>

            <TabsContent value="outline" className="mt-0 max-h-[70vh] overflow-y-auto">
              {hasOutline ? (
                <nav
                  aria-label="Document outline"
                  className="[font-synthesis:none] text-[12px] leading-4 flex flex-col gap-1 antialiased p-2"
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
                          'flex items-center rounded-md py-1.5 gap-2 text-left',
                          'transition-colors duration-150',
                          'focus:outline-none',
                          isSubHeading ? 'pr-2 pl-6' : 'px-2',
                          isActive
                            ? 'bg-sidebar-terracotta/8'
                            : 'hover:bg-[var(--surface-active)]/50'
                        )}
                      >
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
                              ? 'text-sidebar-terracotta font-medium'
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
                <div className="py-6 text-center text-sm text-text-tertiary">No headings found</div>
              )}
            </TabsContent>

            <TabsContent value="info" className="mt-0">
              {hasInfo && stats ? (
                <DocumentInfoTab stats={stats} />
              ) : (
                <div className="py-6 text-center text-sm text-text-tertiary">No info available</div>
              )}
            </TabsContent>
          </Tabs>
        </div>
      )}
    </div>
  )
})

export type { DocumentStats }
