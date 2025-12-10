import { useState } from 'react'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { Info, Pin, PinOff } from 'lucide-react'

interface HeadingItem {
  id: string
  level: number
  text: string
  position: number // Percentage position in document
}

interface OutlineEdgeProps {
  headings?: HeadingItem[]
  onHeadingClick?: (headingId: string) => void
  className?: string
}

export function OutlineEdge({ headings = [], onHeadingClick, className }: OutlineEdgeProps) {
  const [isExpanded, setIsExpanded] = useState(false)
  const [isPinned, setIsPinned] = useState(false)

  const shouldShow = isExpanded || isPinned

  const handleHeadingClick = (headingId: string) => {
    onHeadingClick?.(headingId)
  }

  const togglePin = () => {
    setIsPinned(!isPinned)
    if (!isPinned) {
      setIsExpanded(true)
    }
  }

  return (
    <div
      className={cn('relative h-full', className)}
      onMouseEnter={() => !isPinned && setIsExpanded(true)}
      onMouseLeave={() => !isPinned && setIsExpanded(false)}
    >
      {/* Thin edge strip - always visible */}
      <div
        className={cn(
          'absolute right-0 top-0 h-full w-8 transition-all duration-150 ease-out',
          'bg-transparent hover:bg-stone-50/50',
          shouldShow && 'bg-stone-50/50'
        )}
      >
        {/* Heading indicator bars */}
        <div className="relative h-full py-4">
          {headings.map((heading) => (
            <div
              key={heading.id}
              className={cn(
                'absolute right-2 h-0.5 rounded-full bg-stone-300 transition-all duration-150',
                'hover:bg-stone-400 cursor-pointer',
                heading.level === 1 && 'w-4',
                heading.level === 2 && 'w-3',
                heading.level >= 3 && 'w-2'
              )}
              style={{ top: `${heading.position}%` }}
              onClick={() => handleHeadingClick(heading.id)}
              role="button"
              tabIndex={0}
              aria-label={`Jump to ${heading.text}`}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault()
                  handleHeadingClick(heading.id)
                }
              }}
            />
          ))}
        </div>

        {/* Info button at bottom */}
        <Button
          variant="ghost"
          size="icon"
          className="absolute bottom-2 left-1/2 -translate-x-1/2 h-6 w-6"
          onClick={() => setIsExpanded(!isExpanded)}
          aria-label="Toggle outline"
        >
          <Info className="h-3.5 w-3.5 text-stone-500" />
        </Button>
      </div>

      {/* Expanded outline panel */}
      {shouldShow && (
        <div
          className={cn(
            'absolute right-8 top-0 h-full w-60 transition-all duration-150 ease-out',
            'bg-white border-l border-stone-200 shadow-lg',
            'overflow-hidden'
          )}
        >
          {/* Panel header */}
          <div className="flex items-center justify-between px-4 py-3 border-b border-stone-200">
            <h3 className="text-sm font-medium text-stone-900">Outline</h3>
            <Button
              variant="ghost"
              size="icon"
              className="h-6 w-6"
              onClick={togglePin}
              aria-label={isPinned ? 'Unpin outline' : 'Pin outline'}
            >
              {isPinned ? (
                <PinOff className="h-3.5 w-3.5 text-stone-500" />
              ) : (
                <Pin className="h-3.5 w-3.5 text-stone-500" />
              )}
            </Button>
          </div>

          {/* Outline content */}
          <div className="overflow-y-auto h-[calc(100%-3rem)] p-2">
            {headings.length === 0 ? (
              <div className="flex items-center justify-center h-32 text-sm text-stone-500">
                No headings found
              </div>
            ) : (
              <nav aria-label="Document outline">
                {headings.map((heading) => (
                  <button
                    key={heading.id}
                    onClick={() => handleHeadingClick(heading.id)}
                    className={cn(
                      'w-full text-left px-3 py-1.5 rounded text-sm transition-colors duration-150',
                      'hover:bg-stone-100 text-stone-700 hover:text-stone-900',
                      'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-stone-400',
                      heading.level === 1 && 'font-medium',
                      heading.level === 2 && 'pl-6 text-sm',
                      heading.level === 3 && 'pl-9 text-xs',
                      heading.level >= 4 && 'pl-12 text-xs text-stone-600'
                    )}
                  >
                    {heading.text}
                  </button>
                ))}
              </nav>
            )}
          </div>
        </div>
      )}
    </div>
  )
}
