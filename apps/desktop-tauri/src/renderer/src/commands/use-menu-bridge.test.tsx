import { renderHook } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const bridge = vi.hoisted(() => ({
  handler: null as null | ((event: { command: string }) => void),
  run: vi.fn()
}))

vi.mock('./run-command', () => ({ runCommand: bridge.run }))

import { useMenuBridge } from './use-menu-bridge'

describe('useMenuBridge', () => {
  beforeEach(() => {
    bridge.run.mockClear()
    ;(window as unknown as { api: unknown }).api = {
      onMenuCommand: (callback: (event: { command: string }) => void) => {
        bridge.handler = callback
        return () => {
          bridge.handler = null
        }
      }
    }
  })

  it('runs the command a menu item names, as a menu invocation', () => {
    renderHook(() => useMenuBridge())
    bridge.handler?.({ command: 'tabs.closeTab' })
    expect(bridge.run).toHaveBeenCalledWith('tabs.closeTab', 'menu')
  })

  it('logs and drops an id this build does not know', () => {
    renderHook(() => useMenuBridge())
    bridge.handler?.({ command: 'nope.nothing' })
    expect(bridge.run).not.toHaveBeenCalled()
  })

  it('unsubscribes on unmount', () => {
    const { unmount } = renderHook(() => useMenuBridge())
    expect(bridge.handler).not.toBeNull()
    unmount()
    expect(bridge.handler).toBeNull()
  })
})
