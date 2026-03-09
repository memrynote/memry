import { useState, useEffect, useCallback } from 'react'
import { ToastContainer } from '@/components/ui/toast'
import { SRAnnouncer } from '@/components/sr-announcer'
import type { InboxView } from '@/components/inbox/inbox-segment-control'
import { useInboxNotifications } from '@/hooks/use-inbox-notifications'
import { InboxListView } from './inbox/inbox-list-view'
import { InboxHealthView } from './inbox/inbox-health-view'
import { InboxArchivedView } from './inbox/inbox-archived-view'
import { TriageView } from './inbox/triage-view'

interface InboxPageProps {
  className?: string
}

export function InboxPage({ className }: InboxPageProps): React.JSX.Element {
  const [currentView] = useState<InboxView>('inbox')
  const [isTriageMode, setIsTriageMode] = useState(false)
  const notifications = useInboxNotifications()

  const enterTriage = useCallback(() => setIsTriageMode(true), [])
  const exitTriage = useCallback(() => setIsTriageMode(false), [])

  useEffect(() => {
    const handler = (e: KeyboardEvent): void => {
      if ((e.metaKey || e.ctrlKey) && e.key === 'p') {
        e.preventDefault()
        if (isTriageMode) {
          exitTriage()
        } else {
          enterTriage()
        }
      }
      if (e.key === 'Escape' && isTriageMode) {
        e.preventDefault()
        exitTriage()
      }
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [isTriageMode, enterTriage, exitTriage])

  return (
    <>
      {isTriageMode ? (
        <TriageView onExit={exitTriage} />
      ) : (
        <>
          {currentView === 'inbox' && (
            <InboxListView
              notifications={notifications}
              className={className}
              onEnterTriage={enterTriage}
            />
          )}
          {(currentView as string) === 'archived' && <InboxArchivedView className={className} />}
          {(currentView as string) === 'insights' && <InboxHealthView className={className} />}
        </>
      )}

      <ToastContainer toasts={notifications.toasts} onDismiss={notifications.removeToast} />
      <SRAnnouncer />
    </>
  )
}
