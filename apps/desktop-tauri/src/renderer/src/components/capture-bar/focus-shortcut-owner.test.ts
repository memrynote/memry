/**
 * Ownership of the global `q` focus shortcut.
 *
 * Split view mounts one CaptureBar per pane, so the rule that picks a single
 * winner — and the unregistration that keeps unmounted bars out of the running
 * — are what stop one keypress from firing two handlers.
 */

import { describe, it, expect, afterEach } from 'vitest'
import { ownsFocusShortcut, registerCaptureField } from './focus-shortcut-owner'

const cleanups: Array<() => void> = []

const mount = (field: HTMLElement): void => {
  cleanups.push(registerCaptureField(() => (field.isConnected ? field : null)))
}

const paneWithField = (isActive: boolean): HTMLElement => {
  const pane = document.createElement('div')
  pane.setAttribute('data-pane-active', String(isActive))
  const field = document.createElement('textarea')
  pane.appendChild(field)
  document.body.appendChild(pane)
  return field
}

afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()?.()
  document.body.innerHTML = ''
})

describe('ownsFocusShortcut', () => {
  it('gives the shortcut to the most recent bar when no pane is marked active', () => {
    const first = document.createElement('textarea')
    const second = document.createElement('textarea')
    document.body.append(first, second)
    mount(first)
    mount(second)

    expect(ownsFocusShortcut(second)).toBe(true)
    expect(ownsFocusShortcut(first)).toBe(false)
  })

  it('gives the shortcut to the active pane regardless of mount order', () => {
    const active = paneWithField(true)
    const idle = paneWithField(false)
    mount(active)
    mount(idle)

    expect(ownsFocusShortcut(active)).toBe(true)
    expect(ownsFocusShortcut(idle)).toBe(false)
  })

  it('drops a bar from the running once it unregisters', () => {
    const first = document.createElement('textarea')
    const second = document.createElement('textarea')
    document.body.append(first, second)
    mount(first)
    const unregisterSecond = registerCaptureField(() => second)

    expect(ownsFocusShortcut(first)).toBe(false)

    unregisterSecond()

    expect(ownsFocusShortcut(first)).toBe(true)
  })

  it('never hands the shortcut to a bar with no field', () => {
    expect(ownsFocusShortcut(null)).toBe(false)
  })
})
