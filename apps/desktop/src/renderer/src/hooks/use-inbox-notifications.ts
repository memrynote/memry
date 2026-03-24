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
        queryClient.invalidateQueries({ queryKey: inboxKeys.lists() })

        if ('Notification' in window && Notification.permission === 'granted') {
          const count = dueItems.length
          const title = count === 1 ? dueItems[0].title : `${count} snoozed items`
          const body =
            count === 1 ? 'Your snoozed item is ready for review' : 'Your snoozed items are ready'
          new Notification(title, { body, icon: '/icon.png' })
        }

        toast.info(
          dueItems.length === 1
            ? `"${dueItems[0].title}" is back from snooze`
            : `${dueItems.length} snoozed items are back`
        )
      }
    })

    if ('Notification' in window && Notification.permission === 'default') {
      Notification.requestPermission()
    }

    return () => unsubscribe()
  }, [queryClient])
}
