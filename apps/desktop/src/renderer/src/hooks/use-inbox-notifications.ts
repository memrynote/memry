import { useEffect } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import { onInboxSnoozeDue } from '@/services/inbox-service'
import { inboxKeys } from '@/hooks/use-inbox'

export function useInboxNotifications(): void {
  const queryClient = useQueryClient()

  useEffect(() => {
    const unsubscribe = onInboxSnoozeDue((event) => {
      const { items: dueItems } = event
      if (dueItems.length > 0) {
        void queryClient.invalidateQueries({ queryKey: inboxKeys.lists() })

        if ('Notification' in window && Notification.permission === 'granted') {
          const count = dueItems.length
          const title = count === 1 ? dueItems[0].title : `${count} snoozed items`
          const body =
            count === 1 ? 'Your snoozed item is ready for review' : 'Your snoozed items are ready'
          // The snooze-due event is broadcast to every window, and the inbox page
          // can be mounted more than once inside one window (split view), so a
          // single resurface would otherwise raise one banner per mount. Tagging
          // by the exact set of resurfaced item ids makes the OS collapse those
          // into one banner, while a genuinely different resurface — different
          // ids, even with an identical title — still gets a banner of its own.
          const tag = `inbox-snooze-due:${dueItems
            .map((item) => item.id)
            .sort()
            .join(',')}`
          new Notification(title, { body, icon: '/icon.png', tag })
        }

        toast.info(
          dueItems.length === 1
            ? `"${dueItems[0].title}" is back from snooze`
            : `${dueItems.length} snoozed items are back`
        )
      }
    })

    if ('Notification' in window && Notification.permission === 'default') {
      void Notification.requestPermission()
    }

    return () => unsubscribe()
  }, [queryClient])
}
