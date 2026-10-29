import { useEffect } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import { useT } from '@memry/i18n/renderer'
import { commands } from '../../../generated/bindings'
import { createLogger } from '@/lib/logger'
import { onInboxSnoozeDue } from '@/services/inbox-service'
import { inboxKeys } from '@/hooks/use-inbox'

const log = createLogger('Hook:InboxNotifications')

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

        // A lone resurfaced item names itself: that title is the user's own
        // data, so there is nothing to translate and no plural to select. Two
        // or more collapse into a count, which is a real plural and goes
        // through ICU so locales with more than one/other can spell out their
        // own categories (ru uses `one` again at 21, ar has six).
        const title = count === 1 ? itemTitle : t('snoozeDue.notificationTitle', { count })
        const body = t('snoozeDue.notificationBody', { count })
        // The snooze-due event is broadcast to every window, and the inbox page
        // can be mounted more than once inside one window (split view), so a
        // single resurface would otherwise raise one banner per mount. Keying
        // by the exact set of resurfaced item ids makes the OS collapse those
        // into one banner, while a genuinely different resurface — different
        // ids, even with an identical title — still gets a banner of its own.
        const key = `inbox-snooze-due:${dueItems
          .map((item) => item.id)
          .toSorted()
          .join(',')}`
        // Windows and Linux answer granted. macOS answers prompt until the user was asked, and
        // the show itself asks, so only a denial skips the banner.
        void commands
          .notificationPermission()
          .then((permission) =>
            permission !== 'denied'
              ? commands.notificationShow({
                  key,
                  title,
                  body,
                  silent: false,
                  route: { kind: 'focus' }
                })
              : null
          )
          .catch((error: unknown) => log.warn('could not show the snooze notification', error))

        // One ICU message covers both shapes: the `=1` branch names the item,
        // every other count falls through to the plural categories.
        toast.info(t('snoozeDue.toast', { count, itemTitle }))
      }
    })

    return () => unsubscribe()
  }, [queryClient, t])
}
