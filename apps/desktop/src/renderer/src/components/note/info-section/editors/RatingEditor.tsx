import { useState, useCallback } from 'react'
import { Star } from '@/lib/icons'
import { cn } from '@/lib/utils'

interface RatingEditorProps {
  value: number
  onChange: (value: number) => void
  maxRating?: number
}

export function RatingEditor({ value, onChange, maxRating = 5 }: RatingEditorProps) {
  const [hoverValue, setHoverValue] = useState<number | null>(null)

  const handleClick = useCallback(
    (rating: number) => {
      // If clicking the same rating, toggle it off
      onChange(rating === value ? 0 : rating)
    },
    [value, onChange]
  )

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent, rating: number) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault()
        onChange(rating === value ? 0 : rating)
      }
      if (e.key === 'ArrowRight' && value < maxRating) {
        e.preventDefault()
        onChange(value + 1)
      }
      if (e.key === 'ArrowLeft' && value > 0) {
        e.preventDefault()
        onChange(value - 1)
      }
    },
    [value, maxRating, onChange]
  )

  const displayValue = hoverValue ?? value

  return (
    <div
      role="slider"
      aria-valuemin={0}
      aria-valuemax={maxRating}
      aria-valuenow={value}
      aria-label="Rating"
      className="flex items-center gap-0.5"
      onMouseLeave={() => setHoverValue(null)}
    >
      {Array.from({ length: maxRating }, (_, i) => {
        const rating = i + 1
        const isFilled = rating <= displayValue

        return (
          <button
            key={rating}
            type="button"
            onClick={() => handleClick(rating)}
            onKeyDown={(e) => handleKeyDown(e, rating)}
            onMouseEnter={() => setHoverValue(rating)}
            className={cn(
              'p-0 transition-opacity duration-100',
              'hover:opacity-80',
              'focus:outline-none focus-visible:ring-1 focus-visible:ring-border/40 focus-visible:rounded'
            )}
          >
            <Star
              className={cn(
                'h-3.5 w-3.5 transition-colors duration-100',
                isFilled
                  ? 'fill-amber-400 text-amber-400'
                  : 'fill-transparent text-muted-foreground/20'
              )}
            />
          </button>
        )
      })}
    </div>
  )
}
