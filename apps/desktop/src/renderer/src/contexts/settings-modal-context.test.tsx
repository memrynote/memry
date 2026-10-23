import { describe, it, expect, vi } from 'vitest'
import { act, fireEvent, renderHook } from '@testing-library/react'
import type { ReactNode } from 'react'
import { SETTINGS_SECTIONS, settingsCommandId } from '@memry/contracts/commands'
import { runCommand, useCommandDispatcher } from '@/commands'
import { isMac } from '@/hooks/use-keyboard-shortcuts-base'

vi.mock('@/lib/telemetry', () => ({ trackTelemetry: vi.fn() }))

import { SettingsModalProvider, useSettingsModal } from './settings-modal-context'

function wrapper({ children }: { children: ReactNode }) {
  return <SettingsModalProvider>{children}</SettingsModalProvider>
}

describe('settings modal targets', () => {
  it('opens Vault focused on the activity log for vault:activity', () => {
    const { result } = renderHook(() => useSettingsModal(), { wrapper })

    act(() => {
      result.current.open('vault:activity')
    })

    expect(result.current.isOpen).toBe(true)
    expect(result.current.activeSection).toBe('vault')
    expect(result.current.focusTarget).toBe('vault-activity')
    const firstRequest = result.current.focusRequestId

    act(() => {
      result.current.open('vault:activity')
    })
    expect(result.current.focusRequestId).toBeGreaterThan(firstRequest)
  })

  it('opens Import focused on the Readwise panel for import:readwise', () => {
    const { result } = renderHook(() => useSettingsModal(), { wrapper })

    act(() => {
      result.current.open('import:readwise')
    })

    expect(result.current.activeSection).toBe('import')
    expect(result.current.focusTarget).toBe('readwise-import')
  })

  it('opens a plain section with no focus target', () => {
    const { result } = renderHook(() => useSettingsModal(), { wrapper })

    act(() => {
      result.current.open('vault')
    })

    expect(result.current.activeSection).toBe('vault')
    expect(result.current.focusTarget).toBeNull()
  })
})

describe('nav.settings', () => {
  const mount = () =>
    renderHook(
      () => {
        useCommandDispatcher()
        return useSettingsModal()
      },
      { wrapper }
    )

  it('opens Settings from ⌘, and consumes the key', () => {
    const { result } = mount()

    let notConsumed = true
    act(() => {
      notConsumed = fireEvent.keyDown(window, {
        key: ',',
        ...(isMac ? { metaKey: true } : { ctrlKey: true })
      })
    })

    expect(result.current.isOpen).toBe(true)
    expect(notConsumed).toBe(false)
  })

  it('opens Settings for a menu invocation too', async () => {
    const { result } = mount()

    await act(async () => {
      await runCommand('nav.settings', 'menu')
    })

    expect(result.current.isOpen).toBe(true)
  })

  it.each([
    ['settings.openAppearance', 'appearance'],
    ['settings.openAgentProviders', 'agent-providers'],
    ['settings.openCommandLine', 'command-line'],
    ['settings.openShortcuts', 'shortcuts']
  ] as const)('%s opens the %s section', async (command, section) => {
    const { result } = mount()

    await act(async () => {
      await runCommand(command, 'palette')
    })

    expect(result.current.isOpen).toBe(true)
    expect(result.current.activeSection).toBe(section)
  })

  it('has a command for every section, none for a section that does not exist', async () => {
    const { result } = mount()

    for (const section of SETTINGS_SECTIONS) {
      await act(async () => {
        await runCommand(settingsCommandId(section), 'palette')
      })
      expect(result.current.activeSection).toBe(section)
    }
  })

  it('leaves ⌘, alone once the provider is gone', () => {
    const { unmount } = mount()
    unmount()
    const dispatcher = renderHook(() => {
      useCommandDispatcher()
    })

    const notConsumed = fireEvent.keyDown(window, {
      key: ',',
      ...(isMac ? { metaKey: true } : { ctrlKey: true })
    })

    expect(notConsumed).toBe(true)
    dispatcher.unmount()
  })
})
