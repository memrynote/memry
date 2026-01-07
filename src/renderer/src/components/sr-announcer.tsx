import { useEffect, useState, useCallback } from 'react'

/**
 * Screen Reader Announcer component
 * Uses an aria-live region to announce messages to screen readers
 */

// Global announcement queue
let announceQueue: string[] = []
let announceCallback: ((message: string) => void) | null = null

/**
 * Queue a message to be announced by the screen reader
 * Can be called from anywhere in the app
 */
export const announceToScreenReader = (message: string): void => {
  if (announceCallback) {
    announceCallback(message)
  } else {
    announceQueue.push(message)
  }
}

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
    announceCallback = announce

    // Process any queued announcements
    announceQueue.forEach(announce)
    announceQueue = []

    return () => {
      announceCallback = null
    }
  }, [announce])

  return (
    <div
      id="sr-announcer"
      role="status"
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
    </div>
  )
}

export { SRAnnouncer }
