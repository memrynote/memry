/**
 * Screen Reader Announcer Component
 * Live region for accessibility announcements
 */

import { useState, useEffect } from 'react'
import { useTabGroup } from '@/contexts/tabs'

interface LiveAnnouncerProps {
  /** Group ID to announce changes for */
  groupId: string
}

/**
 * Live region that announces tab changes to screen readers
 */
export const LiveAnnouncer = ({ groupId }: LiveAnnouncerProps): React.JSX.Element => {
  const group = useTabGroup(groupId)
  const [announcement, setAnnouncement] = useState('')

  useEffect(() => {
    if (!group) return

    const activeTab = group.tabs.find((t) => t.id === group.activeTabId)
    if (activeTab) {
      setAnnouncement(`${activeTab.title} tab activated`)
    }
  }, [group?.activeTabId, group?.tabs])

  return (
    <div role="status" aria-live="polite" aria-atomic="true" className="sr-only">
      {announcement}
    </div>
  )
}

export default LiveAnnouncer
