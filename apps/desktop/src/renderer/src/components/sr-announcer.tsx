import { useEffect, useState, useCallback } from 'react'
import { registerAnnounceCallback } from './sr-announcer-queue'

/**
 * Screen Reader Announcer component
 * Uses an aria-live region to announce messages to screen readers
 */

interface SRAnnouncerProps {
  className?: string
}

const SRAnnouncer = ({ className }: SRAnnouncerProps): React.JSX.Element => {
  const [announcement, setAnnouncement] = useState('')

  const announce = useCallback((message: string): void => {
    // Clear previous announcement first to ensure new announcement is read
    setAnnouncement('')

    // Use requestAnimationFrame to ensure the DOM has updated
    requestAnimationFrame(() => {
      setAnnouncement(message)
    })

    // Clear after announcement
    setTimeout(() => {
      setAnnouncement('')
    }, 1000)
  }, [])

  // Register the callback on mount
  useEffect(() => {
    return registerAnnounceCallback(announce)
  }, [announce])

  return (
    <output
      id="sr-announcer"
      aria-live="polite"
      aria-atomic="true"
      className={className}
      // Visually hidden but accessible to screen readers
      style={{
        position: 'absolute',
        width: '1px',
        height: '1px',
        padding: 0,
        margin: '-1px',
        overflow: 'hidden',
        clip: 'rect(0, 0, 0, 0)',
        whiteSpace: 'nowrap',
        border: 0
      }}
    >
      {announcement}
    </output>
  )
}

export { SRAnnouncer }
