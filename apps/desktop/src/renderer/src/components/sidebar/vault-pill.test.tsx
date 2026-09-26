import { act, cleanup, render, screen } from '@testing-library/react'
import type { ReactElement } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { VaultInfo } from '../../../../preload/index.d'
import { VaultPill } from './vault-pill'
import { resetVaultSwitchState, setVaultSwipeProgress } from '@/lib/vault-switch-state'

vi.mock('@/components/vault-switcher', () => ({
  VaultSwitcher: ({
    renderTrigger
  }: {
    renderTrigger: (state: { isLoading: boolean; name: string }) => ReactElement
  }) => renderTrigger({ isLoading: false, name: '' })
}))

function vault(name: string, accentColor: string): VaultInfo {
  return {
    path: `/vaults/${name.toLowerCase()}`,
    name,
    noteCount: 0,
    taskCount: 0,
    lastOpened: '2026-01-01T00:00:00.000Z',
    isDefault: false,
    accentColor
  }
}

const vaults = [vault('Personal', '#f97316'), vault('Work', '#2f6fed')]

function pill(): HTMLElement {
  return screen.getByTestId('vault-pill')
}

function dot(path: string): HTMLElement {
  const el = pill().querySelector<HTMLElement>(`[data-vault-dot="${path}"]`)
  if (!el) throw new Error(`missing dot ${path}`)
  return el
}

describe('VaultPill', () => {
  afterEach(() => {
    cleanup()
    resetVaultSwitchState()
    act(() => setVaultSwipeProgress(null, 0))
  })

  it('shows one accent dot per vault, no name, and opens the list', () => {
    render(<VaultPill vaults={vaults} activePath="/vaults/personal" />)

    expect(pill()).toHaveTextContent('')
    expect(pill()).toHaveAttribute('title', 'Personal')
    expect(pill()).toHaveAccessibleName(/vaultSwipe\.openList|vault list/i)
    expect(pill().querySelectorAll('[data-vault-dot]')).toHaveLength(2)
    expect(dot('/vaults/personal').style.backgroundColor).toBe('rgb(249, 115, 22)')
    expect(dot('/vaults/personal').style.opacity).toBe('1')
    expect(dot('/vaults/work').style.opacity).toBe('0.35')
  })

  it('moves emphasis toward the target dot during a swipe', () => {
    render(<VaultPill vaults={vaults} activePath="/vaults/personal" />)

    act(() => setVaultSwipeProgress('/vaults/work', 0.5))

    expect(dot('/vaults/personal').style.opacity).toBe('0.675')
    expect(dot('/vaults/work').style.opacity).toBe('0.675')
    // The accessible name stays on the open vault until the switch happens.
    expect(pill()).toHaveAttribute('title', 'Personal')
  })
})
