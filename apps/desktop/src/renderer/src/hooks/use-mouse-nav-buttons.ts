import { useCallback, useEffect, useRef } from 'react'
import type {
  AppNavigationCommandEvent,
  AppNavigationDirection
} from '@memry/contracts/ipc-channels'
import { useTabs } from '@/contexts/tabs'

const BACK_BUTTON = 3
const FORWARD_BUTTON = 4
const DUPLICATE_SUPPRESSION_MS = 75
const MOUSE_NAV_EVENTS = ['mousedown', 'mouseup', 'auxclick'] as const

const commandFromMouseButton = (button: number): AppNavigationCommandEvent | null => {
  if (button === BACK_BUTTON) return { direction: 'back' }
  if (button === FORWARD_BUTTON) return { direction: 'forward' }
  return null
}

const commandFromBrowserKey = (key: string): AppNavigationCommandEvent | null => {
  if (key === 'BrowserBack' || key === 'GoBack') return { direction: 'back' }
  if (key === 'BrowserForward' || key === 'GoForward') return { direction: 'forward' }
  return null
}

export const useMouseNavButtons = (): void => {
  const { navBack, navForward, state } = useTabs()
  const activeGroupId = state.activeGroupId
  const lastCommandRef = useRef<{ direction: AppNavigationDirection; timestamp: number } | null>(
    null
  )

  const navigate = useCallback(
    (command: AppNavigationCommandEvent): void => {
      const now = Date.now()
      const lastCommand = lastCommandRef.current
      if (
        lastCommand?.direction === command.direction &&
        now - lastCommand.timestamp < DUPLICATE_SUPPRESSION_MS
      ) {
        return
      }

      lastCommandRef.current = { direction: command.direction, timestamp: now }

      if (command.direction === 'back') navBack(activeGroupId)
      else navForward(activeGroupId)
    },
    [activeGroupId, navBack, navForward]
  )

  useEffect(() => {
    const onMouseNavigation = (e: MouseEvent): void => {
      const command = commandFromMouseButton(e.button)
      if (!command) return

      e.preventDefault()
      e.stopPropagation()
      navigate(command)
    }

    MOUSE_NAV_EVENTS.forEach((eventName) =>
      window.addEventListener(eventName, onMouseNavigation, true)
    )
    return () => {
      MOUSE_NAV_EVENTS.forEach((eventName) =>
        window.removeEventListener(eventName, onMouseNavigation, true)
      )
    }
  }, [navigate])

  useEffect(() => {
    const onBrowserKey = (e: KeyboardEvent): void => {
      const command = commandFromBrowserKey(e.key)
      if (!command) return

      e.preventDefault()
      e.stopPropagation()
      navigate(command)
    }

    window.addEventListener('keydown', onBrowserKey, true)
    return () => {
      window.removeEventListener('keydown', onBrowserKey, true)
    }
  }, [navigate])

  useEffect(() => window.api.onAppNavigationCommand(navigate), [navigate])
}

export default useMouseNavButtons
