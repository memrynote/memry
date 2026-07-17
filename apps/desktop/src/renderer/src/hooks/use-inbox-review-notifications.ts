/**
 * Inbox Review Notifications Hook
 *
 * Surfaces the daily inbox review nudge in-app: a calm toast when the OS
 * notification fires (REVIEW_DUE), and opens the Inbox — the same way the
 * sidebar's inbox entry does — when the user clicks the OS notification
 * (REVIEW_OPEN) or the toast's action.
 *
 * @module hooks/use-inbox-review-notifications
 */

import { useCallback, useEffect } from 'react'
import { toast } from 'sonner'
import { useT } from '@memry/i18n/renderer'
import { useSidebarNavigation } from '@/hooks/use-sidebar-navigation'
import { newItemViewState } from '@/contexts/tabs/helpers'

/**
 * Hook that listens for the scheduled inbox review events and shows a
 * notification. Should be used once at the app level.
 */
export function useInboxReviewNotifications(): void {
  const { t } = useT('inbox')
  const { openSidebarItem } = useSidebarNavigation()

  // Mirrors the sidebar's inbox entry point (app-sidebar.tsx) so the nudge lands
  // the user in exactly the same place as clicking "Inbox". Memoized so the IPC
  // subscriptions below only re-register when navigation identity actually
  // changes, not on every render.
  const openInbox = useCallback((): void => {
    openSidebarItem({
      type: 'inbox',
      title: 'Inbox',
      path: '/inbox',
      viewState: newItemViewState('inbox')
    })
  }, [openSidebarItem])

  // Toast when the OS nudge fires. Depends on `t` so the copy re-localizes.
  useEffect(() => {
    return window.api.onInboxReviewDue(({ count }) => {
      toast(t('reviewNudge.title', { count }), {
        description: t('reviewNudge.description'),
        action: {
          label: t('reviewNudge.action'),
          onClick: openInbox
        }
      })
    })
  }, [openInbox, t])

  // Open the inbox when the user clicks the OS notification. Independent of `t`
  // so a language change never drops this subscription.
  useEffect(() => {
    return window.api.onInboxReviewOpen(openInbox)
  }, [openInbox])
}

export default useInboxReviewNotifications
