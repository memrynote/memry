import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { KeyRotationWizard } from './key-rotation-wizard'

let progressCallback:
  | ((event: { totalItems: number; processedItems: number; phase: string; error?: string }) => void)
  | null = null

vi.mock('@memry/i18n/renderer', () => ({
  useT: () => ({
    t: (key: string, values?: Record<string, unknown>) =>
      values ? `${key}:${JSON.stringify(values)}` : key
  })
}))

vi.mock('@/components/sync/recovery-phrase-display', () => ({
  RecoveryPhraseDisplay: ({ phrase, onContinue }: { phrase: string; onContinue: () => void }) => (
    <button onClick={onContinue}>phrase:{phrase}</button>
  )
}))

describe('KeyRotationWizard', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    progressCallback = null
    window.api.onKeyRotationProgress = vi.fn((callback) => {
      progressCallback = callback
      return vi.fn()
    })
    window.api.crypto = {
      ...window.api.crypto,
      rotateKeys: vi.fn()
    }
  })

  it('renders nothing when closed', () => {
    render(<KeyRotationWizard open={false} onOpenChange={vi.fn()} />)

    expect(screen.queryByText('keyRotation.title')).not.toBeInTheDocument()
  })

  it('rotates keys, tracks progress, confirms the new phrase, and closes', async () => {
    const onOpenChange = vi.fn()
    let resolveRotation: ((value: { success: true; newRecoveryPhrase: string }) => void) | undefined
    vi.mocked(window.api.crypto.rotateKeys).mockReturnValue(
      new Promise((resolve) => {
        resolveRotation = resolve
      })
    )

    render(<KeyRotationWizard open onOpenChange={onOpenChange} />)

    fireEvent.click(screen.getByRole('button', { name: 'keyRotation.start' }))
    expect(window.api.crypto.rotateKeys).toHaveBeenCalledWith({ confirm: true })
    expect(window.api.onKeyRotationProgress).toHaveBeenCalled()

    act(() => {
      progressCallback?.({ totalItems: 10, processedItems: 5, phase: 're-encrypting' })
    })
    expect(screen.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '50')
    expect(
      screen.getByText('keyRotation.phases.reencrypting:{"processed":5,"total":10}')
    ).toBeInTheDocument()

    await act(async () => {
      resolveRotation?.({ success: true, newRecoveryPhrase: 'alpha beta gamma' })
    })
    await waitFor(() => expect(screen.getByText('phrase:alpha beta gamma')).toBeInTheDocument())

    fireEvent.click(screen.getByText('phrase:alpha beta gamma'))
    expect(screen.getByText('keyRotation.complete')).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'button.done' }))
    expect(onOpenChange).toHaveBeenCalledWith(false)
  })

  it('shows result errors, progress errors, and retries rotation', async () => {
    vi.mocked(window.api.crypto.rotateKeys)
      .mockResolvedValueOnce({ success: false, error: 'rotate failed' })
      .mockResolvedValueOnce({ success: true, newRecoveryPhrase: 'new phrase' })

    render(<KeyRotationWizard open onOpenChange={vi.fn()} />)

    fireEvent.click(screen.getByRole('button', { name: 'keyRotation.start' }))
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('rotate failed'))

    fireEvent.click(screen.getByRole('button', { name: 'button.retry' }))
    await waitFor(() => expect(screen.getByText('phrase:new phrase')).toBeInTheDocument())

    act(() => {
      progressCallback?.({
        totalItems: 4,
        processedItems: 1,
        phase: 'preparing',
        error: 'progress failed'
      })
    })

    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('progress failed'))
  })
})
