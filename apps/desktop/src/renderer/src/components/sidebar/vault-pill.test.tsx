import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { VaultInfo } from '../../../../preload/index.d'
import { VaultPill } from './vault-pill'
import {
  requestVaultPage,
  resetVaultSwitchState,
  setVaultSwipeProgress
} from '@/lib/vault-switch-state'
import type * as VaultSwitchState from '@/lib/vault-switch-state'

vi.mock('@/lib/vault-switch-state', async (importOriginal) => ({
  ...(await importOriginal<typeof VaultSwitchState>()),
  requestVaultPage: vi.fn()
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
    vi.mocked(requestVaultPage).mockClear()
    resetVaultSwitchState()
    act(() => setVaultSwipeProgress(null, 0))
  })

  it('shows one accent icon per vault and switches on click', () => {
    render(<VaultPill vaults={vaults} activePath="/vaults/personal" />)

    expect(pill()).toHaveTextContent('')
    expect(pill().querySelectorAll('[data-vault-dot]')).toHaveLength(2)
    const glyph = dot('/vaults/personal').querySelector<HTMLElement>('[data-vault-glyph]')!
    expect(glyph.style.color).toBe('rgb(249, 115, 22)')
    // No icon of its own: the default icon is drawn.
    expect(glyph.querySelector('svg')).not.toBeNull()
    expect(dot('/vaults/personal').style.opacity).toBe('1')
    expect(dot('/vaults/work').style.opacity).toBe('0.35')

    fireEvent.click(dot('/vaults/personal').parentElement!)
    expect(requestVaultPage).not.toHaveBeenCalled()

    fireEvent.click(dot('/vaults/work').parentElement!)
    expect(requestVaultPage).toHaveBeenCalledWith({ path: '/vaults/work' })
  })

  it('draws the vault icon when one is set', () => {
    render(
      <VaultPill vaults={[{ ...vaults[0], icon: '🌿' }, vaults[1]]} activePath="/vaults/personal" />
    )

    expect(dot('/vaults/personal')).toHaveTextContent('🌿')
  })

  it('moves emphasis toward the target dot during a swipe', () => {
    render(<VaultPill vaults={vaults} activePath="/vaults/personal" />)

    act(() => setVaultSwipeProgress('/vaults/work', 0.5))

    expect(dot('/vaults/personal').style.opacity).toBe('0.675')
    expect(dot('/vaults/work').style.opacity).toBe('0.675')
    // The open vault stays current until the switch happens.
    expect(dot('/vaults/personal').parentElement).toHaveAttribute('aria-current', 'true')
  })
})
