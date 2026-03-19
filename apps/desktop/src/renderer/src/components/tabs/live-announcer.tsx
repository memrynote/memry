import { useTabGroup } from '@/contexts/tabs'

interface LiveAnnouncerProps {
  groupId: string
}

export const LiveAnnouncer = ({ groupId }: LiveAnnouncerProps): React.JSX.Element => {
  const group = useTabGroup(groupId)
  const activeTab = group?.tabs.find((t) => t.id === group.activeTabId)
  const announcement = activeTab ? `${activeTab.title} tab activated` : ''

  return (
    <div role="status" aria-live="polite" aria-atomic="true" className="sr-only">
      {announcement}
    </div>
  )
}

export default LiveAnnouncer
