import { act, fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import App from './App'
import { resetVaultSwitchState } from '@/lib/vault-switch-state'

// The window's own Tauri event channels (quit flush, vault events); this test drives none.
vi.mock('@/services/tauri-event', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  subscribeToEvent: () => () => undefined
}))

vi.mock('@/contexts/auth-context', () => ({
  useAuth: () => ({ state: { status: 'authenticated', email: 'kaan@example.com' } })
}))

const vaultApi = window.api.vault as unknown as Record<string, ReturnType<typeof vi.fn>>

// With no vault open, the App gate shows onboarding, and a pending switch swaps it for the
// switching screen. A download from onboarding opens no vault it would leave, so it must not
// start one: onboarding would unmount mid-download and a failure would show nothing.
describe('App gate, downloading an account vault from onboarding', () => {
  beforeEach(() => {
    resetVaultSwitchState()
    vaultApi.getStatus = vi.fn().mockResolvedValue({ isOpen: false, path: null })
    vaultApi.getAll = vi.fn().mockResolvedValue({
      vaults: [{ path: '/Users/k/Old', name: 'Old', noteCount: 0, taskCount: 0 }],
      currentVault: null
    })
    vaultApi.listAccount = vi.fn().mockResolvedValue([
      {
        vaultUuid: 'uuid-work',
        name: 'Work',
        itemCount: 3,
        createdAt: null,
        localPath: null,
        suggestedPath: '/Users/k/Documents/Memry/work'
      }
    ])
    vaultApi.downloadRemote = vi
      .fn()
      .mockResolvedValue({ success: false, vault: null, error: 'The sync server is unreachable' })
  })

  it('keeps a failed download on screen', async () => {
    render(<App />)

    fireEvent.click(await screen.findByRole('button', { name: /Open from Memrynote Sync/ }))
    await screen.findByRole('radio', { name: /Work/ })
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Open vault' }))
    })

    expect(vaultApi.downloadRemote).toHaveBeenCalledWith('uuid-work', expect.any(String))
    expect(await screen.findByText('The sync server is unreachable')).toBeInTheDocument()
  })
})
