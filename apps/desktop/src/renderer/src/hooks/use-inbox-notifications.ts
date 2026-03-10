import { useState, useCallback, useEffect } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import type { Toast } from '@/components/ui/toast'
import { onInboxSnoozeDue } from '@/services/inbox-service'
import { inboxKeys } from '@/hooks/use-inbox'

export interface UseInboxNotificationsResult {
  toasts: Toast[]
  addToast: (toast: Omit<Toast, 'id'>) => string
  removeToast: (id: string) => void
}

function generateToastId(): string {
  return `toast-${Date.now()}-${Math.random().toString(36).substring(2, 9)}`
}

export function useInboxNotifications(): UseInboxNotificationsResult {
  const [toasts, setToasts] = useState<Toast[]>([])
  const queryClient = useQueryClient()

  const addToast = useCallback((toast: Omit<Toast, 'id'>): string => {
    const id = generateToastId()
    setToasts((prev) => [...prev, { ...toast, id }])
    return id
  }, [])

  const removeToast = useCallback((id: string): void => {
    setToasts((prev) => prev.filter((toast) => toast.id !== id))
  }, [])

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

        addToast({
          message:
            dueItems.length === 1
              ? `"${dueItems[0].title}" is back from snooze`
              : `${dueItems.length} snoozed items are back`,
          type: 'info'
        })
      }
    })

    if ('Notification' in window && Notification.permission === 'default') {
      Notification.requestPermission()
    }

    return () => unsubscribe()
  }, [queryClient, addToast])

  return { toasts, addToast, removeToast }
}
