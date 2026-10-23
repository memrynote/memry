import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { LINK_FAILURE_SETUP_SESSION_EXPIRED } from '@memry/contracts/ipc-devices'

import { IpcFailureError } from '@/lib/ipc-error'

const hoisted = vi.hoisted(() => ({
  linkViaRecovery: vi.fn()
}))

vi.mock('@/contexts/auth-context', () => ({
  useAuth: () => ({ linkViaRecovery: hoisted.linkViaRecovery })
}))

// Stub RecoveryPhraseInput so the test can drive submit/back/error deterministically
// without reproducing its 24-word validation UI.
vi.mock('./recovery-phrase-input', () => ({
  RecoveryPhraseInput: ({
    onSubmit,
    isLoading,
    error,
    onBack
  }: {
    onSubmit: (phrase: string) => void
    isLoading: boolean
    error: string | null
    onBack: () => void
  }) => (
    <div>
      <button onClick={() => onSubmit('valid recovery phrase')}>submit-phrase</button>
      <button onClick={onBack}>back</button>
      {isLoading && <span>loading</span>}
      {error && <span data-testid="phrase-error">{error}</span>}
    </div>
  )
}))

import { VaultRecoveryDialog } from './vault-recovery-dialog'

const openInput = (): void => {
  fireEvent.click(screen.getByRole('button', { name: 'Enter recovery phrase' }))
}

describe('VaultRecoveryDialog', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('renders nothing when closed', () => {
    render(
      <VaultRecoveryDialog
        open={false}
        onRecovered={vi.fn()}
        onDismiss={vi.fn()}
        onSignOut={vi.fn()}
      />
    )
    expect(screen.queryByText(/open your vault/i)).not.toBeInTheDocument()
  })

  it('shows the intro and dismisses via Later', () => {
    const onDismiss = vi.fn()
    render(
      <VaultRecoveryDialog open onRecovered={vi.fn()} onDismiss={onDismiss} onSignOut={vi.fn()} />
    )
    expect(screen.getByText(/open your vault/i)).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Later' }))
    expect(onDismiss).toHaveBeenCalledTimes(1)
  })

  it('recovers: submitting the phrase calls linkViaRecovery, then onRecovered on success', async () => {
    hoisted.linkViaRecovery.mockResolvedValueOnce({ deviceId: 'dev-1' })
    const onRecovered = vi.fn()
    render(
      <VaultRecoveryDialog open onRecovered={onRecovered} onDismiss={vi.fn()} onSignOut={vi.fn()} />
    )

    openInput()
    fireEvent.click(screen.getByRole('button', { name: 'submit-phrase' }))

    await waitFor(() =>
      expect(hoisted.linkViaRecovery).toHaveBeenCalledWith('valid recovery phrase')
    )
    await waitFor(() => expect(onRecovered).toHaveBeenCalledTimes(1))
  })

  it('offers re-auth when the setup token has expired', async () => {
    hoisted.linkViaRecovery.mockRejectedValueOnce(
      new IpcFailureError(
        'Your sign-in timed out before this finished.',
        LINK_FAILURE_SETUP_SESSION_EXPIRED
      )
    )
    const onSignOut = vi.fn()
    const onRecovered = vi.fn()
    render(
      <VaultRecoveryDialog
        open
        onRecovered={onRecovered}
        onDismiss={vi.fn()}
        onSignOut={onSignOut}
      />
    )

    openInput()
    fireEvent.click(screen.getByRole('button', { name: 'submit-phrase' }))

    await waitFor(() => expect(screen.getByTestId('phrase-error')).toHaveTextContent(/timed out/i))
    expect(onRecovered).not.toHaveBeenCalled()

    fireEvent.click(screen.getByRole('button', { name: 'Sign in again' }))
    expect(onSignOut).toHaveBeenCalledTimes(1)
  })

  it('offers re-auth on a non-English message carrying the expiry code', async () => {
    // #given the main process localized the message before it crossed IPC.
    // The old English regex (/sign in again|session expired/i) matched nothing
    // here, so 29 of the 30 locales lost the button entirely (#1202).
    hoisted.linkViaRecovery.mockRejectedValueOnce(
      new IpcFailureError(
        'Deine Anmeldung ist abgelaufen, bevor dies abgeschlossen wurde.',
        LINK_FAILURE_SETUP_SESSION_EXPIRED
      )
    )
    const onSignOut = vi.fn()
    render(
      <VaultRecoveryDialog open onRecovered={vi.fn()} onDismiss={vi.fn()} onSignOut={onSignOut} />
    )

    openInput()
    fireEvent.click(screen.getByRole('button', { name: 'submit-phrase' }))

    // #then the control the message tells the user to use is actually present.
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Sign in again' })).toBeInTheDocument()
    )
    fireEvent.click(screen.getByRole('button', { name: 'Sign in again' }))
    expect(onSignOut).toHaveBeenCalledTimes(1)
  })

  it('does not offer re-auth for an unrelated failure that merely mentions signing in', async () => {
    // #given wording that the old regex matched by accident.
    hoisted.linkViaRecovery.mockRejectedValueOnce(
      new Error('Recovery phrase does not match. Sign in again on another device.')
    )
    render(
      <VaultRecoveryDialog open onRecovered={vi.fn()} onDismiss={vi.fn()} onSignOut={vi.fn()} />
    )

    openInput()
    fireEvent.click(screen.getByRole('button', { name: 'submit-phrase' }))

    await waitFor(() =>
      expect(screen.getByTestId('phrase-error')).toHaveTextContent(/does not match/i)
    )
    expect(screen.queryByRole('button', { name: 'Sign in again' })).not.toBeInTheDocument()
  })

  it('offers a start-fresh escape that only signs out after an explicit confirmation', () => {
    const onSignOut = vi.fn()
    render(
      <VaultRecoveryDialog open onRecovered={vi.fn()} onDismiss={vi.fn()} onSignOut={onSignOut} />
    )

    openInput()
    fireEvent.click(screen.getByRole('button', { name: /recovery phrase back/i }))

    // Consequences are stated before anything is destroyed.
    expect(screen.getByText(/without the recovery phrase/i)).toBeInTheDocument()
    expect(onSignOut).not.toHaveBeenCalled()

    // Backing out returns to the phrase input with the session intact.
    fireEvent.click(screen.getByRole('button', { name: 'Go back' }))
    expect(onSignOut).not.toHaveBeenCalled()
    expect(screen.getByRole('button', { name: 'submit-phrase' })).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: /recovery phrase back/i }))
    fireEvent.click(screen.getByRole('button', { name: 'Sign out and start fresh' }))
    expect(onSignOut).toHaveBeenCalledTimes(1)
  })

  it('surfaces a wrong-phrase error without recovering or offering re-auth', async () => {
    hoisted.linkViaRecovery.mockRejectedValueOnce(
      new Error('Recovery phrase does not match. Please try again.')
    )
    const onRecovered = vi.fn()
    render(
      <VaultRecoveryDialog open onRecovered={onRecovered} onDismiss={vi.fn()} onSignOut={vi.fn()} />
    )

    openInput()
    fireEvent.click(screen.getByRole('button', { name: 'submit-phrase' }))

    await waitFor(() =>
      expect(screen.getByTestId('phrase-error')).toHaveTextContent(/does not match/i)
    )
    expect(onRecovered).not.toHaveBeenCalled()
    expect(screen.queryByRole('button', { name: 'Sign in again' })).not.toBeInTheDocument()
  })
})
