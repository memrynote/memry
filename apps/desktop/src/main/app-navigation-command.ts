import { AppChannels, type AppNavigationCommandEvent } from '@memry/contracts/ipc-channels'

interface IpcEventTarget {
  send: (channel: string, payload: AppNavigationCommandEvent) => void
}

export interface AppNavigationKeyboardInput {
  type: string
  key?: string
  code?: string
  isAutoRepeat?: boolean
  shift?: boolean
  control?: boolean
  alt?: boolean
  meta?: boolean
  modifiers?: string[]
}

export type AppNavigationSwipeDirection = 'left' | 'right' | 'up' | 'down'

const BROWSER_BACK_KEYS = new Set(['browserback', 'browser-back', 'browser-backward', 'goback'])
const BROWSER_FORWARD_KEYS = new Set(['browserforward', 'browser-forward', 'goforward'])

const normalizeInputKey = (key: string | undefined): string => key?.toLowerCase() ?? ''

export const appCommandToNavigationCommand = (
  command: string
): AppNavigationCommandEvent | null => {
  if (command === 'browser-backward') return { direction: 'back' }
  if (command === 'browser-forward') return { direction: 'forward' }
  return null
}

export const keyboardInputToNavigationCommand = (
  input: AppNavigationKeyboardInput
): AppNavigationCommandEvent | null => {
  if (input.type !== 'keyDown' || input.isAutoRepeat) return null

  const keys = [normalizeInputKey(input.key), normalizeInputKey(input.code)]
  if (keys.some((key) => BROWSER_BACK_KEYS.has(key))) return { direction: 'back' }
  if (keys.some((key) => BROWSER_FORWARD_KEYS.has(key))) return { direction: 'forward' }
  return null
}

export const swipeDirectionToNavigationCommand = (
  direction: AppNavigationSwipeDirection
): AppNavigationCommandEvent | null => {
  if (direction === 'left') return { direction: 'back' }
  if (direction === 'right') return { direction: 'forward' }
  return null
}

export const sendAppNavigationDirection = (
  target: IpcEventTarget,
  direction: AppNavigationCommandEvent['direction']
): void => {
  const payload: AppNavigationCommandEvent = { direction }
  target.send(AppChannels.events.NAVIGATION_COMMAND, payload)
}

export const sendAppNavigationCommand = (target: IpcEventTarget, command: string): boolean => {
  const payload = appCommandToNavigationCommand(command)
  if (!payload) return false

  sendAppNavigationDirection(target, payload.direction)
  return true
}

export const sendAppNavigationKeyboardCommand = (
  target: IpcEventTarget,
  input: AppNavigationKeyboardInput
): boolean => {
  const payload = keyboardInputToNavigationCommand(input)
  if (!payload) return false

  sendAppNavigationDirection(target, payload.direction)
  return true
}

export const sendAppNavigationSwipeCommand = (
  target: IpcEventTarget,
  direction: AppNavigationSwipeDirection
): boolean => {
  const payload = swipeDirectionToNavigationCommand(direction)
  if (!payload) return false

  sendAppNavigationDirection(target, payload.direction)
  return true
}
