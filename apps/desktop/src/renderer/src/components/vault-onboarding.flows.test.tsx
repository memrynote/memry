import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  selectVault: vi.fn(),
  switchVault: vi.fn(),
  auth: {
    status: 'unauthenticated' as string,
    email: 'kaan@example.com' as string | null
  }
}))

vi.mock('@/lib/telemetry', () => ({ trackTelemetry: vi.fn() }))

vi.mock('@memry/i18n/renderer', () => ({
  useT: () => ({
    t: (key: string) => key,
    i18n: { resolvedLanguage: 'en', language: 'en', changeLanguage: vi.fn() }
  })
}))

vi.mock('@/hooks/use-vault', () => ({
  useVault: () => ({
    selectVault: mocks.selectVault,
    switchVault: mocks.switchVault,
    isLoading: false,
    error: null
  }),
  useVaultList: () => ({ vaults: [], currentVault: null })
}))

vi.mock('@/components/traffic-lights', () => ({
  TrafficLights: () => <div data-testid="traffic-lights" />
}))

vi.mock('@/contexts/auth-context', () => ({
  useAuth: () => ({ state: mocks.auth })
}))

vi.mock('@/pages/settings/setup-wizard', () => ({
  SetupWizard: () => <div data-testid="setup-wizard" />
}))

import { VaultOnboarding } from './vault-onboarding'

const vaultApi = window.api.vault as unknown as Record<string, ReturnType<typeof vi.fn>>

const openView = async (name: RegExp): Promise<void> => {
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name }))
  })
}

describe('VaultOnboarding flows', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.auth.status = 'unauthenticated'
    mocks.selectVault.mockResolvedValue({ success: true, vault: { path: '/x' } })
    vaultApi.getDefaultParent = vi.fn().mockResolvedValue('/Users/k/Documents/Memry')
    vaultApi.create = vi.fn().mockResolvedValue({ success: true, vault: { path: '/x' } })
    vaultApi.listAccount = vi.fn().mockResolvedValue([])
    vaultApi.downloadRemote = vi.fn().mockResolvedValue({ success: true, vault: { path: '/x' } })
    vaultApi.switch = vi.fn().mockResolvedValue({ success: true, vault: { path: '/x' } })
  })

  describe('create new vault', () => {
    it('creates <parent>/<name> from the form instead of opening a folder picker', async () => {
      render(<VaultOnboarding />)
      await openView(/createNewVault/)

      const input = await screen.findByPlaceholderText(
        'phaseF.componentsVaultOnboarding.flow.namePlaceholder'
      )
      fireEvent.change(input, { target: { value: 'Personal' } })
      expect(await screen.findByText('/Users/k/Documents/Memry/Personal')).toBeInTheDocument()

      await act(async () => {
        fireEvent.click(screen.getByRole('button', { name: /flow\.createVault/ }))
      })

      expect(vaultApi.create).toHaveBeenCalledWith('/Users/k/Documents/Memry', 'Personal')
      expect(mocks.selectVault).not.toHaveBeenCalled()
    })

    it('offers to open an existing folder when the name is taken', async () => {
      vaultApi.create.mockResolvedValue({
        success: false,
        vault: null,
        error: 'exists',
        errorCode: 'already-exists'
      })
      render(<VaultOnboarding />)
      await openView(/createNewVault/)

      const input = await screen.findByPlaceholderText(
        'phaseF.componentsVaultOnboarding.flow.namePlaceholder'
      )
      fireEvent.change(input, { target: { value: 'Work' } })
      await waitFor(() =>
        expect(screen.getByRole('button', { name: /flow\.createVault/ })).toBeEnabled()
      )
      await act(async () => {
        fireEvent.click(screen.getByRole('button', { name: /flow\.createVault/ }))
      })

      expect(screen.getByText(/flow\.errorExists/)).toBeInTheDocument()
      await act(async () => {
        fireEvent.click(screen.getByRole('button', { name: /flow\.openInstead/ }))
      })
      expect(mocks.selectVault).toHaveBeenCalledWith('/Users/k/Documents/Memry/Work')
    })

    it('blocks names that cannot be a folder before calling main', async () => {
      render(<VaultOnboarding />)
      await openView(/createNewVault/)

      const input = await screen.findByPlaceholderText(
        'phaseF.componentsVaultOnboarding.flow.namePlaceholder'
      )
      fireEvent.change(input, { target: { value: '../escape' } })

      expect(screen.getByText(/flow\.errorInvalidName/)).toBeInTheDocument()
      expect(screen.getByRole('button', { name: /flow\.createVault/ })).toBeDisabled()
    })
  })

  describe('open from sync', () => {
    it('shows the sign-in wizard until the account is unlocked', async () => {
      render(<VaultOnboarding />)
      await openView(/flow\.openFromSync/)

      expect(screen.getByTestId('setup-wizard')).toBeInTheDocument()
      expect(vaultApi.listAccount).not.toHaveBeenCalled()
    })

    it('lists account vaults once signed in and downloads the single chosen one', async () => {
      mocks.auth.status = 'authenticated'
      vaultApi.listAccount.mockResolvedValue([
        {
          vaultUuid: 'uuid-personal',
          name: 'Personal',
          itemCount: 12,
          createdAt: null,
          localPath: null,
          suggestedPath: '/Users/k/Documents/Memry/personal'
        },
        {
          vaultUuid: 'uuid-work',
          name: 'Work',
          itemCount: 3,
          createdAt: null,
          localPath: null,
          suggestedPath: '/Users/k/Documents/Memry/work'
        }
      ])
      render(<VaultOnboarding />)
      await openView(/flow\.openFromSync/)

      const work = await screen.findByRole('radio', { name: /Work/ })
      expect(screen.getByRole('radio', { name: /Personal/ })).toHaveAttribute(
        'aria-checked',
        'true'
      )
      fireEvent.click(work)
      expect(work).toHaveAttribute('aria-checked', 'true')

      await act(async () => {
        fireEvent.click(screen.getByRole('button', { name: /flow\.openVault/ }))
      })

      expect(vaultApi.downloadRemote).toHaveBeenCalledTimes(1)
      expect(vaultApi.downloadRemote).toHaveBeenCalledWith('uuid-work', '/Users/k/Documents/Memry')
    })

    it('opens the local copy of a vault already on this computer', async () => {
      mocks.auth.status = 'authenticated'
      vaultApi.listAccount.mockResolvedValue([
        {
          vaultUuid: 'uuid-research',
          name: 'Research',
          itemCount: 5,
          createdAt: null,
          localPath: '/Users/k/Research',
          suggestedPath: '/Users/k/Documents/Memry/research'
        }
      ])
      render(<VaultOnboarding />)
      await openView(/flow\.openFromSync/)

      expect(await screen.findByText(/flow\.onThisComputer/)).toBeInTheDocument()
      await act(async () => {
        fireEvent.click(screen.getByRole('button', { name: /flow\.openVault/ }))
      })

      expect(vaultApi.switch).toHaveBeenCalledWith('/Users/k/Research')
      expect(vaultApi.downloadRemote).not.toHaveBeenCalled()
    })

    it('sends a fresh account with no vaults to the create form', async () => {
      mocks.auth.status = 'authenticated'
      render(<VaultOnboarding />)
      await openView(/flow\.openFromSync/)

      await act(async () => {
        fireEvent.click(await screen.findByRole('button', { name: /flow\.createCta/ }))
      })

      expect(
        await screen.findByPlaceholderText('phaseF.componentsVaultOnboarding.flow.namePlaceholder')
      ).toBeInTheDocument()
    })
  })
})
