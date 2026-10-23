import { useEffect } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import { useT } from '@memry/i18n/renderer'
import { onInboxSnoozeDue } from '@/services/inbox-service'
import { inboxKeys } from '@/hooks/use-inbox'

export function useInboxNotifications(): void {
  const queryClient = useQueryClient()
  const { t } = useT('inbox')

  useEffect(() => {
    const unsubscribe = onInboxSnoozeDue((event) => {
      const { items: dueItems } = event
      if (dueItems.length > 0) {
        void queryClient.invalidateQueries({ queryKey: inboxKeys.lists() })

        const count = dueItems.length
        const itemTitle = dueItems[0].title

        if ('Notification' in window && Notification.permission === 'granted') {
          // A lone resurfaced item names itself: that title is the user's own
          // data, so there is nothing to translate and no plural to select. Two
          // or more collapse into a count, which is a real plural and goes
          // through ICU so locales with more than one/other can spell out their
          // own categories (ru uses `one` again at 21, ar has six).
          const title = count === 1 ? itemTitle : t('snoozeDue.notificationTitle', { count })
          const body = t('snoozeDue.notificationBody', { count })
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

        // One ICU message covers both shapes: the `=1` branch names the item,
        // every other count falls through to the plural categories.
        toast.info(t('snoozeDue.toast', { count, itemTitle }))
      }
    })

    return () => unsubscribe()
  }, [queryClient, t])

  // Asking for permission is deliberately its own effect: `t` changes identity
  // when the user switches language, and re-running the prompt on a language
  // change would re-ask anyone who dismissed the first request.
  useEffect(() => {
    if ('Notification' in window && Notification.permission === 'default') {
      void Notification.requestPermission()
    }
  }, [])
}
