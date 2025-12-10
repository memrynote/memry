/**
 * Content Divider Component
 * Horizontal separator line at the top of the content area
 */

import { cn } from '@/lib/utils'

interface ContentDividerProps {
  className?: string
}

/**
 * ContentDivider - Simple horizontal line separating metadata from content
 * Design spec: 1px height, #e7e5e4 (stone-200) background, 24px vertical margin
 */
export function ContentDivider({ className }: ContentDividerProps) {
  return (
    <div
      className={cn(
        'w-full h-px',
        'bg-stone-200',
        'my-6', // 24px margin
        className
      )}
      role="separator"
      aria-orientation="horizontal"
    />
  )
}
