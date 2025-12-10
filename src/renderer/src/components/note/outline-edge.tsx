import { useState, useRef } from 'react'
import { cn } from '@/lib/utils'

interface HeadingItem {
  id: string
  level: number
  text: string
  position: number
}

interface OutlineEdgeProps {
  headings?: HeadingItem[]
  onHeadingClick?: (headingId: string) => void
  className?: string
  activeHeadingId?: string
}

export function OutlineEdge({
  headings = [],
  onHeadingClick,
  className,
  activeHeadingId
}: OutlineEdgeProps) {
  const [isHovered, setIsHovered] = useState(false)
  const containerRef = useRef<HTMLDivElement>(null)

  const handleHeadingClick = (headingId: string) => {
    onHeadingClick?.(headingId)
  }

  return (
    <div
      ref={containerRef}
      className={cn('absolute right-8 top-0 z-40 hidden md:block', className)}
      onMouseEnter={() => setIsHovered(true)}
      onMouseLeave={() => setIsHovered(false)}
    >
      {/* Show bars when NOT hovered, show popup when hovered */}
      {!isHovered ? (
        // Outline indicator bars - visible when not hovered
        <div
          className={cn(
            'flex flex-col gap-3 pl-5 pb-3 cursor-pointer',
            'transition-opacity duration-150'
          )}
          style={{ paddingTop: '16px' }}
        >
          {headings.length > 0 ? (
            headings.map((heading) => (
              <div key={heading.id}>
                <div
                  className="h-0.5 rounded-sm transition-all duration-200"
                  style={{
                    width: heading.level === 1 ? '16px' : '12px',
                    marginInlineStart: heading.level === 1 ? '0px' : '4px',
                    backgroundColor: heading.id === activeHeadingId
                      ? 'rgb(28, 25, 23)' // stone-900
                      : 'rgb(120, 113, 108)', // stone-500
                  }}
                />
              </div>
            ))
          ) : (
            // Default indicators
            <>
              <div><div className="h-0.5 w-4 rounded-sm bg-stone-500" /></div>
              <div><div className="h-0.5 w-3 rounded-sm bg-stone-500 ml-1" /></div>
              <div><div className="h-0.5 w-3 rounded-sm bg-stone-500 ml-1" /></div>
            </>
          )}
        </div>
      ) : (
        // Popup menu - visible when hovered (replaces bars)
        <div
          className={cn(
            'bg-white border border-stone-200 shadow-lg rounded-lg',
            'py-2 min-w-[200px] max-w-[200px] max-h-[400px] overflow-y-auto',
            'animate-in fade-in-0 duration-150'
          )}
        >
          {headings.length === 0 ? (
            <div className="px-3 py-4 text-sm text-stone-500 text-center">
              No headings found
            </div>
          ) : (
            <nav aria-label="Document outline">
              {headings.map((heading) => (
                <button
                  key={heading.id}
                  onClick={() => handleHeadingClick(heading.id)}
                  className={cn(
                    'w-full text-left px-3 py-1.5 text-sm transition-colors duration-150',
                    'hover:bg-stone-100 text-stone-700 hover:text-stone-900',
                    'focus:outline-none focus:bg-stone-100',
                    heading.level === 1 && 'font-medium',
                    heading.level === 2 && 'pl-5',
                    heading.level === 3 && 'pl-7 text-xs',
                    heading.level >= 4 && 'pl-9 text-xs text-stone-600',
                    heading.id === activeHeadingId && 'bg-stone-50 text-stone-900'
                  )}
                >
                  {heading.text}
                </button>
              ))}
            </nav>
          )}
        </div>
      )}
    </div>
  )
}
