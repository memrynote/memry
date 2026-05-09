import { AppChannels } from '@memry/contracts/ipc-channels'
import { describe, expect, it, vi } from 'vitest'

import {
  keyboardInputToNavigationCommand,
  sendAppNavigationCommand,
  sendAppNavigationKeyboardCommand,
  sendAppNavigationSwipeCommand,
  swipeDirectionToNavigationCommand
} from './app-navigation-command'

describe('sendAppNavigationCommand', () => {
  it('maps browser-backward app-command to the navigation IPC event', () => {
    const target = { send: vi.fn() }

    const sent = sendAppNavigationCommand(target, 'browser-backward')

    expect(sent).toBe(true)
    expect(target.send).toHaveBeenCalledWith(AppChannels.events.NAVIGATION_COMMAND, {
      direction: 'back'
    })
  })

  it('maps browser-forward app-command to the navigation IPC event', () => {
    const target = { send: vi.fn() }

    const sent = sendAppNavigationCommand(target, 'browser-forward')

    expect(sent).toBe(true)
    expect(target.send).toHaveBeenCalledWith(AppChannels.events.NAVIGATION_COMMAND, {
      direction: 'forward'
    })
  })

  it('ignores unrelated app-command values', () => {
    const target = { send: vi.fn() }

    const sent = sendAppNavigationCommand(target, 'browser-refresh')

    expect(sent).toBe(false)
    expect(target.send).not.toHaveBeenCalled()
  })
})

describe('sendAppNavigationKeyboardCommand', () => {
  it('maps dedicated BrowserBack keyboard input to the navigation IPC event', () => {
    const target = { send: vi.fn() }

    const sent = sendAppNavigationKeyboardCommand(target, {
      type: 'keyDown',
      key: 'BrowserBack'
    })

    expect(sent).toBe(true)
    expect(target.send).toHaveBeenCalledWith(AppChannels.events.NAVIGATION_COMMAND, {
      direction: 'back'
    })
  })

  it('maps dedicated BrowserForward keyboard input to the navigation IPC event', () => {
    const target = { send: vi.fn() }

    const sent = sendAppNavigationKeyboardCommand(target, {
      type: 'keyDown',
      key: 'BrowserForward'
    })

    expect(sent).toBe(true)
    expect(target.send).toHaveBeenCalledWith(AppChannels.events.NAVIGATION_COMMAND, {
      direction: 'forward'
    })
  })

  it('ignores keyup and repeated browser keyboard input', () => {
    expect(
      keyboardInputToNavigationCommand({
        type: 'keyUp',
        key: 'BrowserBack'
      })
    ).toBeNull()
    expect(
      keyboardInputToNavigationCommand({
        type: 'keyDown',
        key: 'BrowserBack',
        isAutoRepeat: true
      })
    ).toBeNull()
  })
})

describe('sendAppNavigationSwipeCommand', () => {
  it('maps left swipe to back navigation for Logitech MX back button events', () => {
    const target = { send: vi.fn() }

    const sent = sendAppNavigationSwipeCommand(target, 'left')

    expect(sent).toBe(true)
    expect(target.send).toHaveBeenCalledWith(AppChannels.events.NAVIGATION_COMMAND, {
      direction: 'back'
    })
  })

  it('maps right swipe to forward navigation for Logitech MX next button events', () => {
    const target = { send: vi.fn() }

    const sent = sendAppNavigationSwipeCommand(target, 'right')

    expect(sent).toBe(true)
    expect(target.send).toHaveBeenCalledWith(AppChannels.events.NAVIGATION_COMMAND, {
      direction: 'forward'
    })
  })

  it('ignores vertical swipes', () => {
    expect(swipeDirectionToNavigationCommand('up')).toBeNull()
    expect(swipeDirectionToNavigationCommand('down')).toBeNull()
  })
})
