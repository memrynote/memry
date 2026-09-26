import { act, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent } from '@testing-library/react'

// Hoist mutable state so factory functions close over the same references.
const mockSelectVault = vi.fn()
const mockSwitchVault = vi.fn()
let mockVaults: Array<{ path: string; name: string }> = []
let mockCurrentVault: string | null = null

vi.mock('@/lib/telemetry', () => ({ trackTelemetry: vi.fn() }))

vi.mock('@memry/i18n/renderer', () => ({
  useT: () => ({
    t: (key: string) => key,
    i18n: { resolvedLanguage: 'en', language: 'en', changeLanguage: vi.fn() }
  })
}))

vi.mock('@/hooks/use-vault', () => ({
  useVault: () => ({
    selectVault: mockSelectVault,
    switchVault: mockSwitchVault,
    isLoading: false,
    error: null
  }),
  useVaultList: () => ({ vaults: mockVaults, currentVault: mockCurrentVault })
}))

vi.mock('@/components/traffic-lights', () => ({
  TrafficLights: () => <div data-testid="traffic-lights" />
}))

import { trackTelemetry } from '@/lib/telemetry'
import { VaultOnboarding } from './vault-onboarding'

describe('VaultOnboarding telemetry', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockVaults = []
    mockCurrentVault = null
    mockSelectVault.mockResolvedValue({
      success: true,
      vault: { path: '/vaults/Main' },
      error: null
    })
    mockSwitchVault.mockResolvedValue({
      success: true,
      vault: { path: '/vaults/Main' },
      error: null
    })
  })

  it('tracks onboarding_started on mount', () => {
    render(<VaultOnboarding />)
    expect(trackTelemetry).toHaveBeenCalledWith('onboarding_started', {
      surface: 'onboarding',
      action: 'started'
    })
  })

  it('tracks onboarding_started only once across re-renders', () => {
    const { rerender } = render(<VaultOnboarding />)
    rerender(<VaultOnboarding />)
    const startedCalls = (trackTelemetry as ReturnType<typeof vi.fn>).mock.calls.filter(
      ([name]) => name === 'onboarding_started'
    )
    expect(startedCalls).toHaveLength(1)
  })

  it('tracks onboarding_completed when selectVault succeeds (open folder)', async () => {
    render(<VaultOnboarding />)
    // "Open folder as vault" goes straight to the native picker via selectVault.
    const openFolder = screen.getByRole('button', { name: /flow\.openFolder/ })
    await act(async () => {
      fireEvent.click(openFolder)
    })
    expect(trackTelemetry).toHaveBeenCalledWith('onboarding_completed', {
      surface: 'onboarding',
      action: 'completed',
      result: 'success'
    })
  })

  it('tracks onboarding_completed when switchVault succeeds (open recent vault)', async () => {
    mockVaults = [{ path: '/vaults/Old', name: 'Old Vault' }]
    render(<VaultOnboarding />)
    const vaultBtn = screen.getByText('Old Vault').closest('button')!
    await act(async () => {
      fireEvent.click(vaultBtn)
    })
    expect(trackTelemetry).toHaveBeenCalledWith('onboarding_completed', {
      surface: 'onboarding',
      action: 'completed',
      result: 'success'
    })
  })

  it('does not track onboarding_completed when selectVault fails', async () => {
    mockSelectVault.mockResolvedValue({ success: false, vault: null, error: 'cancelled' })
    render(<VaultOnboarding />)
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /flow\.openFolder/ }))
    })
    const completedCalls = (trackTelemetry as ReturnType<typeof vi.fn>).mock.calls.filter(
      ([name]) => name === 'onboarding_completed'
    )
    expect(completedCalls).toHaveLength(0)
  })

  it('does not track onboarding_completed when switchVault fails', async () => {
    mockVaults = [{ path: '/vaults/Old', name: 'Old Vault' }]
    mockSwitchVault.mockResolvedValue({ success: false, vault: null, error: 'cancelled' })
    render(<VaultOnboarding />)
    const vaultBtn = screen.getByText('Old Vault').closest('button')!
    await act(async () => {
      fireEvent.click(vaultBtn)
    })
    const completedCalls = (trackTelemetry as ReturnType<typeof vi.fn>).mock.calls.filter(
      ([name]) => name === 'onboarding_completed'
    )
    expect(completedCalls).toHaveLength(0)
  })
})
