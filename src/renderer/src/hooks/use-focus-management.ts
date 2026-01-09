/**
 * Focus Management Hook
 * Manages focus across split view panes
 */

import { useEffect } from 'react'
import { useTabs } from '@/contexts/tabs'

/**
 * Hook to track and manage focus across panes
 * Automatically sets active group when a pane receives focus
 */
export const useFocusManagement = (): void => {
  const { state, dispatch } = useTabs()

  useEffect(() => {
    const handleFocusIn = (e: FocusEvent): void => {
      const target = e.target as HTMLElement
      const pane = target.closest('[data-pane-id]')

      if (pane) {
        const paneId = pane.getAttribute('data-pane-id')
        if (paneId && paneId !== state.activeGroupId) {
          dispatch({
            type: 'SET_ACTIVE_GROUP',
            payload: { groupId: paneId }
          })
        }
      }
    }

    document.addEventListener('focusin', handleFocusIn)
    return () => document.removeEventListener('focusin', handleFocusIn)
  }, [state.activeGroupId, dispatch])
}

export default useFocusManagement
