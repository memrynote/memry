/**
 * Skip to Content Link
 * Skip link for keyboard users to bypass tab bar
 */

import { cn } from '@/lib/utils'

interface SkipToContentProps {
  /** Target element ID to skip to */
  targetId?: string
  /** Link text */
  children?: React.ReactNode
}

/**
 * Accessible skip link for keyboard navigation
 */
export const SkipToContent = ({
  targetId = 'main-content',
  children = 'Skip to main content'
}: SkipToContentProps): React.JSX.Element => {
  return (
    <a
      href={`#${targetId}`}
      className={cn(
        'sr-only focus:not-sr-only',
        'fixed top-2 left-2 z-50',
        'px-4 py-2 bg-tint text-tint-foreground rounded-md',
        'focus:outline-none'
      )}
    >
      {children}
    </a>
  )
}

export default SkipToContent
