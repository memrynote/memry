import { useState, useEffect, useCallback } from 'react'
import { ToastContainer } from '@/components/ui/toast'
import { SRAnnouncer } from '@/components/sr-announcer'
import { InboxSegmentControl, type InboxView } from '@/components/inbox/inbox-segment-control'
import { useInboxNotifications } from '@/hooks/use-inbox-notifications'
import { InboxListView } from './inbox/inbox-list-view'
import { InboxHealthView } from './inbox/inbox-health-view'
import { InboxArchivedView } from './inbox/inbox-archived-view'
import { TriageView } from './inbox/triage-view'

interface InboxPageProps {
  className?: string
}

export function InboxPage({ className }: InboxPageProps): React.JSX.Element {
  const [currentView, setCurrentView] = useState<InboxView>('inbox')
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
        <div className="flex h-full flex-col">
          <div className="flex shrink-0 items-center justify-center px-4 pt-3 pb-1">
            <InboxSegmentControl value={currentView} onChange={setCurrentView} />
          </div>
          <div className="min-h-0 flex-1">
            {currentView === 'inbox' && (
              <InboxListView
                notifications={notifications}
                className={className}
                onEnterTriage={enterTriage}
              />
            )}
            {currentView === 'archived' && <InboxArchivedView className={className} />}
            {currentView === 'insights' && <InboxHealthView className={className} />}
          </div>
        </div>
      )}

      <ToastContainer toasts={notifications.toasts} onDismiss={notifications.removeToast} />
      <SRAnnouncer />
    </>
  )
}
