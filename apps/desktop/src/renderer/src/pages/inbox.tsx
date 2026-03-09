import { useState } from 'react'
import { ToastContainer } from '@/components/ui/toast'
import { SRAnnouncer } from '@/components/sr-announcer'
import type { InboxView } from '@/components/inbox/inbox-segment-control'
import { useInboxNotifications } from '@/hooks/use-inbox-notifications'
import { InboxListView } from './inbox/inbox-list-view'
import { InboxHealthView } from './inbox/inbox-health-view'
import { InboxArchivedView } from './inbox/inbox-archived-view'

interface InboxPageProps {
  className?: string
}

export function InboxPage({ className }: InboxPageProps): React.JSX.Element {
  const [currentView] = useState<InboxView>('inbox')
  const notifications = useInboxNotifications()

  return (
    <>
      {currentView === 'inbox' && (
        <InboxListView notifications={notifications} className={className} />
      )}

      {(currentView as string) === 'archived' && <InboxArchivedView className={className} />}

      {(currentView as string) === 'insights' && <InboxHealthView className={className} />}

      <ToastContainer toasts={notifications.toasts} onDismiss={notifications.removeToast} />
      <SRAnnouncer />
    </>
  )
}
