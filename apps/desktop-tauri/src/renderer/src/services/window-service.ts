import { commands, events } from '../../../generated/bindings'
import { createLogger } from '../lib/logger'
import { subscribeToEvent } from './tauri-event'

const log = createLogger('WindowService')

type NavigationCommand = { direction: 'back' | 'forward' }

function report(command: string): (error: unknown) => void {
  return (error) => log.warn(`${command} failed`, error)
}

/**
 * The window functions of `window.api` over their Rust commands. Each acts on the calling
 * window, resolved by the shell from the IPC call, never from focus.
 */
export const windowApi = {
  windowMinimize: (): void => {
    commands.windowMinimize().catch(report('window_minimize'))
  },
  windowMaximize: (): void => {
    commands.windowToggleMaximize().catch(report('window_toggle_maximize'))
  },
  windowClose: (): void => {
    commands.windowClose().catch(report('window_close'))
  },
  setZoomFactor: (factor: number): void => {
    commands.appSetZoomFactor(factor).catch(report('app_set_zoom_factor'))
  },
  onAppNavigationCommand: (callback: (command: NavigationCommand) => void): (() => void) =>
    subscribeToEvent(events.appNavigationRequestedEvent, ({ direction }) => {
      if (direction === 'back' || direction === 'forward') callback({ direction })
    })
}
