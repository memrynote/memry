import { act, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { VaultScopeProvider } from '@/contexts/vault-scope'
import { beginVaultSwitch, endVaultSwitch, resetVaultSwitchState } from '@/lib/vault-switch-state'
import { VAULT_SWITCH_COVER_DELAY_MS, VaultSwitchContentCover } from './vault-switch-content-cover'

function renderIn(vaultPath: string) {
  return render(
    <VaultScopeProvider vaultPath={vaultPath}>
      <VaultSwitchContentCover />
    </VaultScopeProvider>
  )
}

describe('VaultSwitchContentCover', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    resetVaultSwitchState()
  })

  afterEach(() => {
    vi.useRealTimers()
    resetVaultSwitchState()
  })

  it('covers the vault being left once the switch outlasts the delay', () => {
    renderIn('/a')
    act(() => beginVaultSwitch({ path: '/b', name: 'Beta' }, 'next'))

    // A quick switch never shows it.
    act(() => vi.advanceTimersByTime(VAULT_SWITCH_COVER_DELAY_MS - 1))
    expect(screen.queryByTestId('vault-switch-content-cover')).toBeNull()

    act(() => vi.advanceTimersByTime(1))
    expect(screen.getByTestId('vault-switch-content-cover')).toHaveTextContent('Switching to Beta')

    act(() => endVaultSwitch(true))
    expect(screen.queryByTestId('vault-switch-content-cover')).toBeNull()
  })

  it('does not cover the vault being entered', () => {
    renderIn('/b')
    act(() => beginVaultSwitch({ path: '/b', name: 'Beta' }, 'next'))
    act(() => vi.advanceTimersByTime(VAULT_SWITCH_COVER_DELAY_MS))
    expect(screen.queryByTestId('vault-switch-content-cover')).toBeNull()
  })

  it('waits out the delay again on a later switch to the same vault', () => {
    renderIn('/a')
    act(() => beginVaultSwitch({ path: '/b', name: 'Beta' }, 'next'))
    act(() => vi.advanceTimersByTime(VAULT_SWITCH_COVER_DELAY_MS))
    act(() => endVaultSwitch(false))

    act(() => beginVaultSwitch({ path: '/b', name: 'Beta' }, 'next'))
    expect(screen.queryByTestId('vault-switch-content-cover')).toBeNull()
  })
})
