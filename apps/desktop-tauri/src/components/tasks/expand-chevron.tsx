import { useState } from 'react'

import { ChevronDown } from '@/lib/icons'
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
        'focus-visible:outline-none rounded',
        isAnimating && 'scale-110',
        className
      )}
      aria-expanded={isExpanded}
      aria-label={isExpanded ? 'Collapse subtasks' : 'Expand subtasks'}
    >
      <ChevronDown
        size={10}
        className={cn('transition-transform duration-200 ease-out', !isExpanded && '-rotate-90')}
      />
    </button>
  )
}

export default ExpandChevron
