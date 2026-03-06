/**
 * Truncated Tab Title Component
 * Handles very long tab titles with truncation and tooltip
 */

import { useState, useRef, useEffect } from 'react'
import { cn } from '@/lib/utils'

interface TruncatedTabTitleProps {
  /** Title text */
  title: string
  /** Maximum width in pixels */
  maxWidth?: number
  /** Additional CSS classes */
  className?: string
}

/**
 * Tab title that truncates with tooltip for long text
 */
export const TruncatedTabTitle = ({
  title,
  maxWidth = 150,
  className
}: TruncatedTabTitleProps): React.JSX.Element => {
  const [isTruncated, setIsTruncated] = useState(false)
  const textRef = useRef<HTMLSpanElement>(null)

  useEffect(() => {
    if (textRef.current) {
      setIsTruncated(textRef.current.scrollWidth > textRef.current.clientWidth)
    }
  }, [title, maxWidth])

  return (
    <span
      ref={textRef}
      className={cn('truncate block', className)}
      style={{ maxWidth }}
      title={isTruncated ? title : undefined}
    >
      {title}
    </span>
  )
}

export default TruncatedTabTitle
