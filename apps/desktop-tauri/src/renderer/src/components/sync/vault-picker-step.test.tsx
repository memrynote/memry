import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { VaultPickerStep } from './vault-picker-step'

vi.mock('@memry/i18n/renderer', () => ({
  useT: () => ({
    t: (key: string) => key
  })
}))

const vaults = [
  { vaultUuid: 'v-a', itemCount: 367, createdAt: 1000 },
  { vaultUuid: 'v-b', itemCount: 4, createdAt: 2000 }
]

describe('VaultPickerStep', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    window.api.syncLinking = {
      ...window.api.syncLinking,
      pickVaultFolder: vi.fn().mockResolvedValue({ path: '/tmp/parent' }),
      finalizeVaultChoice: vi.fn().mockResolvedValue({ success: true })
    }
  })

  it('disables the confirm button until a folder is chosen', () => {
    render(<VaultPickerStep sessionId="sess-1" vaults={vaults} onError={vi.fn()} />)
    expect(screen.getByRole('button', { name: 'setup.linking.vaultPickerConfirm' })).toBeDisabled()
  })

  it('finalizes with the chosen folder, the checked vaults, and the first as primary', async () => {
    render(<VaultPickerStep sessionId="sess-1" vaults={vaults} onError={vi.fn()} />)

    // v-a is checked by default; also check v-b.
    fireEvent.click(screen.getByLabelText('v-b'))

    fireEvent.click(screen.getByRole('button', { name: 'setup.linking.vaultPickerChooseFolder' }))
    await screen.findByRole('button', { name: '/tmp/parent' })

    fireEvent.click(screen.getByRole('button', { name: 'setup.linking.vaultPickerConfirm' }))

    await waitFor(() =>
      expect(window.api.syncLinking.finalizeVaultChoice).toHaveBeenCalledWith({
        sessionId: 'sess-1',
        parentFolderPath: '/tmp/parent',
        selectedVaultUuids: ['v-a', 'v-b'],
        primaryVaultUuid: 'v-a'
      })
    )
  })

  it('surfaces a finalize failure via onError', async () => {
    const onError = vi.fn()
    window.api.syncLinking.finalizeVaultChoice = vi
      .fn()
      .mockResolvedValue({ success: false, error: 'boom' })
    render(<VaultPickerStep sessionId="sess-1" vaults={vaults} onError={onError} />)

    fireEvent.click(screen.getByRole('button', { name: 'setup.linking.vaultPickerChooseFolder' }))
    await screen.findByRole('button', { name: '/tmp/parent' })
    fireEvent.click(screen.getByRole('button', { name: 'setup.linking.vaultPickerConfirm' }))

    await waitFor(() => expect(onError).toHaveBeenCalledWith('boom'))
  })

  it('shows the finalize failure in the step itself', async () => {
    window.api.syncLinking.finalizeVaultChoice = vi
      .fn()
      .mockResolvedValue({ success: false, error: 'boom' })
    render(<VaultPickerStep sessionId="sess-1" vaults={vaults} onError={vi.fn()} />)

    fireEvent.click(screen.getByRole('button', { name: 'setup.linking.vaultPickerChooseFolder' }))
    await screen.findByRole('button', { name: '/tmp/parent' })
    fireEvent.click(screen.getByRole('button', { name: 'setup.linking.vaultPickerConfirm' }))

    // The wizard renders `wizardError` only on the sign-in/OTP/recovery steps,
    // so without this the failure is invisible and the button looks dead.
    expect(await screen.findByRole('alert')).toHaveTextContent('boom')
  })
})
