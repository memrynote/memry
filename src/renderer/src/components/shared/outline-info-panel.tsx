/**
 * OutlineInfoPanel Component
 *
 * An enhanced outline indicator that shows document structure with a tabbed interface.
 * - Default: Thin horizontal lines (width varies by level), active highlighted
 * - Hover: Popup with tabs for Outline (headings) and Info (document stats)
 *
 * Used by both Note and Journal pages for consistent document navigation.
 */

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

/**
 * Get line width based on heading level
 * H1: 24px (longest), H2: 16px (medium), H3+: 10px (shortest)
 */
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

export const OutlineInfoPanel = memo(function OutlineInfoPanel({
  headings = [],
  onHeadingClick,
  className,
  activeHeadingId,
  stats
}: OutlineInfoPanelProps) {
  const [isHovered, setIsHovered] = useState(false)
  const [activeTab, setActiveTab] = useState<string>('outline')
  const containerRef = useRef<HTMLDivElement>(null)
  const popupRef = useRef<HTMLDivElement>(null)
  const hoverTimeoutRef = useRef<NodeJS.Timeout | null>(null)

  const handleClick = useCallback(
    (headingId: string) => {
      onHeadingClick?.(headingId)
    },
    [onHeadingClick]
  )

  // Debounced hover handlers to prevent flickering
  const handleMouseEnter = useCallback(() => {
    if (hoverTimeoutRef.current) {
      clearTimeout(hoverTimeoutRef.current)
      hoverTimeoutRef.current = null
    }
    setIsHovered(true)
  }, [])

  const handleMouseLeave = useCallback(() => {
    // Delay hiding to prevent flicker when moving within component
    hoverTimeoutRef.current = setTimeout(() => {
      setIsHovered(false)
    }, 150)
  }, [])

  // Auto-scroll to active heading when popup opens (only on outline tab)
  useEffect(() => {
    if (isHovered && activeHeadingId && popupRef.current && activeTab === 'outline') {
      // Small delay to ensure DOM is rendered
      requestAnimationFrame(() => {
        const activeElement = popupRef.current?.querySelector(
          `[data-heading-id="${activeHeadingId}"]`
        )
        if (activeElement) {
          activeElement.scrollIntoView({ block: 'center', behavior: 'instant' })
        }
      })
    }
  }, [isHovered, activeHeadingId, activeTab])

  // Cleanup timeout on unmount
  useEffect(() => {
    return () => {
      if (hoverTimeoutRef.current) {
        clearTimeout(hoverTimeoutRef.current)
      }
    }
  }, [])

  // Don't render if no headings AND no stats
  if (headings.length === 0 && !stats) {
    return null
  }

  // Calculate vertical line height based on number of headings
  const verticalLineHeight = headings.length > 0 ? Math.max(0, (headings.length - 1) * 14 + 4) : 0

  // Determine if we have content for each tab
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
      {!isHovered ? (
        // ====== DEFAULT STATE: Indicator bars ======
        <div className="flex items-start gap-0 cursor-pointer">
          {/* Horizontal bars */}
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
                        ? 'rgb(28, 25, 23)' // stone-900 - active
                        : 'rgb(168, 162, 158)', // stone-400 - inactive
                      opacity: isActive ? 1 : 0.4
                    }}
                  />
                )
              })}
            </div>
          )}

          {/* Vertical connector line */}
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

          {/* Info indicator dot when no headings but has stats */}
          {headings.length === 0 && hasInfo && (
            <div
              className="w-2 h-2 rounded-full bg-stone-400/40 hover:bg-stone-400/60 transition-colors"
              aria-label="Document info available"
            />
          )}
        </div>
      ) : (
        // ====== HOVER STATE: Tabbed popup ======
        <div
          ref={popupRef}
          className={cn(
            'bg-white dark:bg-stone-900 border border-stone-200 dark:border-stone-700',
            'shadow-lg rounded-lg',
            'min-w-[240px] max-w-[300px]',
            'animate-in fade-in-0 zoom-in-95 duration-150'
          )}
        >
          <Tabs value={activeTab} onValueChange={setActiveTab} className="w-full">
            <TabsList className="w-full h-8 p-0.5 bg-stone-100 dark:bg-stone-800 rounded-t-lg rounded-b-none">
              <TabsTrigger
                value="outline"
                className={cn(
                  'flex-1 h-7 text-xs font-medium rounded-md',
                  'data-[state=active]:bg-white data-[state=active]:dark:bg-stone-900',
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
                  'data-[state=active]:bg-white data-[state=active]:dark:bg-stone-900',
                  'data-[state=active]:shadow-sm',
                  !hasInfo && 'opacity-50 cursor-not-allowed'
                )}
                disabled={!hasInfo}
              >
                Info
              </TabsTrigger>
            </TabsList>

            {/* Outline Tab Content */}
            <TabsContent value="outline" className="mt-0 max-h-[70vh] overflow-y-auto">
              {hasOutline ? (
                <nav aria-label="Document outline" className="py-1">
                  {headings.map((heading) => {
                    const isActive = heading.id === activeHeadingId

                    return (
                      <button
                        key={heading.id}
                        data-heading-id={heading.id}
                        onClick={() => handleClick(heading.id)}
                        className={cn(
                          'w-full text-left px-3 py-1.5 text-sm',
                          'transition-colors duration-150',
                          'hover:bg-stone-100 dark:hover:bg-stone-800',
                          'focus:outline-none focus:bg-stone-100 dark:focus:bg-stone-800',
                          // Indentation based on level
                          heading.level === 1 && 'font-medium text-stone-900 dark:text-stone-100',
                          heading.level === 2 && 'pl-5 text-stone-700 dark:text-stone-300',
                          heading.level === 3 && 'pl-7 text-xs text-stone-600 dark:text-stone-400',
                          heading.level >= 4 && 'pl-9 text-xs text-stone-500 dark:text-stone-500',
                          // Active state - highlighted
                          isActive &&
                            'bg-blue-50 dark:bg-blue-900/30 text-blue-700 dark:text-blue-300 font-medium'
                        )}
                      >
                        <span className="line-clamp-2">{heading.text}</span>
                      </button>
                    )
                  })}
                </nav>
              ) : (
                <div className="py-6 text-center text-sm text-stone-500">No headings found</div>
              )}
            </TabsContent>

            {/* Info Tab Content */}
            <TabsContent value="info" className="mt-0">
              {hasInfo && stats ? (
                <DocumentInfoTab stats={stats} />
              ) : (
                <div className="py-6 text-center text-sm text-stone-500">No info available</div>
              )}
            </TabsContent>
          </Tabs>
        </div>
      )}
    </div>
  )
})

export type { DocumentStats }
