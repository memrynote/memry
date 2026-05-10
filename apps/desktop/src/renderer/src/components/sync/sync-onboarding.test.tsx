import { act, fireEvent, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { DownloadProgress } from './download-progress'
import { EmailEntryForm } from './email-entry-form'
import { InitialSyncProgress } from './initial-sync-progress'
import { OtpInput } from './otp-input'
import { OtpVerification } from './otp-verification'
import { RecoveryPhraseConfirm } from './recovery-phrase-confirm'
import { RecoveryPhraseDisplay } from './recovery-phrase-display'
import { RecoveryPhraseInput } from './recovery-phrase-input'
import { UploadProgress } from './upload-progress'

const mocks = vi.hoisted(() => ({
  syncState: {
    initialSyncProgress: null as null | { phase: string; current: number; total: number }
  },
  clipboardWrite: vi.fn()
}))

vi.mock('@memry/i18n/renderer', () => ({
  useT: () => ({
    t: (key: string, values?: Record<string, unknown>) =>
      `${key}${values ? JSON.stringify(values) : ''}`
  })
}))

vi.mock('@/contexts/sync-context', () => ({
  useSync: () => ({ state: mocks.syncState })
}))

vi.mock('@/components/ui/input-otp', () => ({
  InputOTP: ({
    children,
    value,
    onChange,
    disabled,
    'aria-label': ariaLabel
  }: {
    children: React.ReactNode
    value: string
    onChange: (value: string) => void
    disabled?: boolean
    'aria-label'?: string
  }) => (
    <div>
      <input
        aria-label={ariaLabel}
        value={value}
        disabled={disabled}
        onChange={(event) => onChange(event.target.value)}
      />
      {children}
    </div>
  ),
  InputOTPGroup: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  InputOTPSlot: ({ index }: { index: number }) => <span data-testid={`otp-slot-${index}`} />
}))

const phrase = Array.from({ length: 24 }, (_, i) => `word${i + 1}`).join(' ')

const setOtpDetected = () => {
  let detectedCallback: ((event: { code?: string }) => void) | undefined
  ;(window.api as any).onOtpDetected = vi.fn((callback: (event: { code?: string }) => void) => {
    detectedCallback = callback
    return vi.fn()
  })
  return () => detectedCallback
}

describe('sync onboarding components', () => {
  beforeEach(() => {
    vi.useRealTimers()
    vi.clearAllMocks()
    mocks.syncState.initialSyncProgress = null
    mocks.clipboardWrite.mockResolvedValue(undefined)
    const navigatorWithClipboard = new Proxy(window.navigator, {
      get(target, property, receiver) {
        if (property === 'clipboard') {
          return { writeText: mocks.clipboardWrite }
        }
        const value = Reflect.get(target, property, receiver)
        return typeof value === 'function' ? value.bind(target) : value
      }
    })
    Object.defineProperty(globalThis, 'navigator', {
      value: navigatorWithClipboard,
      configurable: true
    })
    Object.defineProperty(window, 'navigator', {
      value: navigatorWithClipboard,
      configurable: true
    })
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  it('validates email input and submits trimmed valid emails', async () => {
    const user = userEvent.setup()
    const submit = vi.fn()

    render(<EmailEntryForm onSubmit={submit} isLoading={false} error={null} defaultEmail="bad" />)

    fireEvent.submit(screen.getByLabelText('setup.email.label').closest('form')!)
    expect(screen.getByRole('alert')).toHaveTextContent('setup.email.invalid')
    expect(submit).not.toHaveBeenCalled()

    await user.clear(screen.getByLabelText('setup.email.label'))
    await user.type(screen.getByLabelText('setup.email.label'), '  kaan@example.com  ')
    await user.click(screen.getByRole('button', { name: 'button.continue' }))
    expect(submit).toHaveBeenCalledWith('kaan@example.com')
  })

  it('handles OTP typing, auto-detected codes, resend countdown, and wrapper copy', async () => {
    vi.useFakeTimers()
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime })
    const getDetectedCallback = setOtpDetected()
    const complete = vi.fn()
    const resend = vi.fn()
    const back = vi.fn()

    render(
      <OtpVerification
        email="kaan@example.com"
        onVerify={complete}
        onResend={resend}
        onBack={back}
        isVerifying={false}
        isResending={false}
        error={null}
        expiresIn={1}
      />
    )

    expect(screen.getByText('kaan@example.com')).toBeInTheDocument()
    await user.type(screen.getByLabelText('setup.otp.aria'), '123456')
    expect(complete).toHaveBeenCalledWith('123456')

    act(() => vi.advanceTimersByTime(1000))
    await user.click(screen.getByRole('button', { name: 'setup.otp.resend' }))
    expect(resend).toHaveBeenCalledTimes(1)

    await user.click(screen.getByRole('button', { name: 'setup.otp.differentEmail' }))
    expect(back).toHaveBeenCalledTimes(1)

    act(() => getDetectedCallback()?.({ code: '654321' }))
    expect(complete).toHaveBeenCalledWith('654321')
    vi.useRealTimers()
  })

  it('shows OTP verifying, resending, and error states', () => {
    setOtpDetected()
    render(
      <OtpInput
        onComplete={vi.fn()}
        onResend={vi.fn()}
        onBack={vi.fn()}
        isVerifying
        isResending
        error="Wrong code"
        expiresIn={60}
      />
    )

    expect(screen.getByRole('status', { name: 'setup.otp.verifying' })).toBeInTheDocument()
    expect(screen.getByRole('alert')).toHaveTextContent('Wrong code')
    expect(screen.getByText('setup.otp.resending')).toBeInTheDocument()
  })

  it('copies recovery phrases, clears clipboard timers, and continues', async () => {
    vi.useFakeTimers()
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime })
    const onContinue = vi.fn()
    const { unmount } = render(<RecoveryPhraseDisplay phrase={phrase} onContinue={onContinue} />)

    expect(screen.getAllByRole('listitem')).toHaveLength(24)
    fireEvent.click(screen.getByRole('button', { name: 'setup.recovery.copyAria' }))
    await act(async () => {})
    expect(mocks.clipboardWrite).toHaveBeenCalledWith(phrase)
    expect(screen.getByRole('button', { name: 'setup.recovery.copiedAria' })).toBeInTheDocument()

    act(() => vi.advanceTimersByTime(2000))
    expect(screen.getByRole('button', { name: 'setup.recovery.copyAria' })).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: 'setup.recovery.saved' }))
    expect(onContinue).toHaveBeenCalledTimes(1)

    unmount()
    expect(mocks.clipboardWrite).toHaveBeenCalledWith('')
    vi.useRealTimers()
  })

  it('confirms selected recovery words and supports going back', async () => {
    vi.spyOn(crypto, 'getRandomValues').mockImplementation((array) => {
      const values = array as Uint32Array
      values[0] = 0
      values[1] = 5
      values[2] = 10
      return array
    })
    const confirmed = vi.fn()
    const back = vi.fn()

    render(<RecoveryPhraseConfirm phrase={phrase} onConfirmed={confirmed} onBack={back} />)

    const verifyButton = screen.getByRole('button', { name: 'setup.recovery.verify' })
    expect(verifyButton).toBeDisabled()

    const inputs = screen.getAllByRole('textbox')
    fireEvent.change(inputs[0], { target: { value: 'word1' } })
    fireEvent.blur(inputs[0])
    fireEvent.change(inputs[1], { target: { value: 'wrong' } })
    fireEvent.blur(inputs[1])
    expect(verifyButton).toBeDisabled()

    fireEvent.change(inputs[1], { target: { value: 'word6' } })
    fireEvent.change(inputs[2], { target: { value: 'WORD11' } })
    expect(verifyButton).toBeEnabled()
    fireEvent.click(verifyButton)
    expect(confirmed).toHaveBeenCalledTimes(1)

    fireEvent.click(screen.getByRole('button', { name: 'button.back' }))
    expect(back).toHaveBeenCalledTimes(1)
  })

  it('normalizes submitted recovery phrases and advances loading progress labels', async () => {
    vi.useFakeTimers()
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime })
    const submit = vi.fn()
    const { rerender } = render(
      <RecoveryPhraseInput onSubmit={submit} isLoading={false} error={null} onBack={vi.fn()} />
    )

    await user.type(screen.getByLabelText('setup.recovery.inputLabel'), 'short phrase')
    expect(screen.getByText('setup.recovery.lengthHint')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'setup.recovery.restore' })).toBeDisabled()

    await user.clear(screen.getByLabelText('setup.recovery.inputLabel'))
    await user.type(screen.getByLabelText('setup.recovery.inputLabel'), phrase.toUpperCase())
    await user.click(screen.getByRole('button', { name: 'setup.recovery.restore' }))
    expect(submit).toHaveBeenCalledWith(phrase)

    rerender(
      <RecoveryPhraseInput onSubmit={submit} isLoading error="Bad phrase" onBack={vi.fn()} />
    )
    expect(screen.getByRole('alert')).toHaveTextContent('Bad phrase')
    expect(screen.getByText('setup.recovery.progress.deriving')).toBeInTheDocument()
    act(() => vi.advanceTimersByTime(4000))
    expect(screen.getByText('setup.recovery.progress.registering')).toBeInTheDocument()
    vi.useRealTimers()
  })

  it('renders upload, download, and initial sync progress states', async () => {
    const cancel = vi.fn()
    const { rerender } = render(
      <UploadProgress fileName="memo.pdf" progress={25} status="uploading" onCancel={cancel} />
    )

    expect(screen.getByRole('status')).toHaveAccessibleName('Upload memo.pdf: Uploading... 25%')
    await userEvent.click(screen.getByRole('button', { name: 'Cancel upload of memo.pdf' }))
    expect(cancel).toHaveBeenCalledTimes(1)

    rerender(<UploadProgress fileName="memo.pdf" progress={100} status="completed" />)
    expect(screen.getByText('Upload complete')).toBeInTheDocument()

    rerender(<DownloadProgress fileName="memo.pdf" progress={40} status="decrypting" />)
    expect(screen.getByRole('progressbar', { name: 'Download progress: 40%' })).toHaveAttribute(
      'aria-valuenow',
      '40'
    )
    rerender(<DownloadProgress fileName="memo.pdf" progress={110} status="failed" />)
    expect(screen.getByText('Download failed')).toBeInTheDocument()

    mocks.syncState.initialSyncProgress = { phase: 'notes', current: 3, total: 6 }
    rerender(<InitialSyncProgress />)
    expect(screen.getByRole('status')).toHaveAccessibleName('Downloading items: 3 of 6')
    expect(screen.getByText('3/6')).toBeInTheDocument()

    mocks.syncState.initialSyncProgress = { phase: 'unknown', current: 0, total: 0 }
    rerender(<InitialSyncProgress />)
    expect(screen.getByRole('status')).toHaveAccessibleName('Syncing: in progress')
  })
})
