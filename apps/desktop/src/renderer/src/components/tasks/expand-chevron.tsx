import { useState } from 'react'

import { cn } from '@/lib/utils'

interface ExpandChevronProps {
  isExpanded: boolean
  hasSubtasks: boolean
  onClick: () => void
  size?: 'sm' | 'md'
  className?: string
}

export const ExpandChevron = ({
  isExpanded,
  hasSubtasks,
  onClick,
  size = 'md',
  className
}: ExpandChevronProps): React.JSX.Element => {
  const [isAnimating, setIsAnimating] = useState(false)

  if (!hasSubtasks) {
    return (
      <div
        className={cn('shrink-0', size === 'sm' ? 'w-[10px] h-[10px]' : 'w-[10px] h-[10px]')}
        aria-hidden="true"
      />
    )
  }

  const handleClick = (e: React.MouseEvent): void => {
    e.stopPropagation()
    setIsAnimating(true)
    onClick()
    setTimeout(() => setIsAnimating(false), 200)
  }

  const handleKeyDown = (e: React.KeyboardEvent): void => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault()
      e.stopPropagation()
      setIsAnimating(true)
      onClick()
      setTimeout(() => setIsAnimating(false), 200)
    }
  }

  return (
    <button
      type="button"
      data-expand-button
      onClick={handleClick}
      onKeyDown={handleKeyDown}
      tabIndex={0}
      className={cn(
        'flex items-center justify-center shrink-0',
        'transition-all duration-150',
        'text-text-tertiary hover:text-muted-foreground',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 rounded',
        isAnimating && 'scale-110',
        className
      )}
      aria-expanded={isExpanded}
      aria-label={isExpanded ? 'Collapse subtasks' : 'Expand subtasks'}
    >
      <svg
        width="10"
        height="10"
        viewBox="0 0 10 10"
        fill="none"
        className={cn('transition-transform duration-200 ease-out', !isExpanded && '-rotate-90')}
      >
        <path
          d="M2.5 3.5L5 6.5L7.5 3.5"
          stroke="currentColor"
          strokeWidth="1.4"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
    </button>
  )
}

export default ExpandChevron
