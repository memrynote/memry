import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { forwardRef, useImperativeHandle } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { CaptureInput } from './capture-input'

const mocks = vi.hoisted(() => ({
  captureText: vi.fn(),
  captureLink: vi.fn(),
  captureVoice: vi.fn(),
  captureImage: vi.fn(),
  openSettings: vi.fn(),
  ensureReady: vi.fn(),
  prepareAudio: vi.fn(),
  recorderStart: vi.fn()
}))

vi.mock('@memry/i18n/renderer', () => ({
  useT: () => ({
    t: (key: string, values?: Record<string, unknown>) => {
      const leaf = key.split('.').at(-1) || key
      // Echo the placeholder names too, so a call site that stops matching the
      // {placeholder} in the English string fails here instead of shipping raw.
      return values
        ? `${leaf}:${Object.entries(values)
            .map(([name, value]) => `${name}=${String(value)}`)
            .join('/')}`
        : leaf
    }
  })
}))

vi.mock('@/hooks/use-inbox', () => ({
  useCaptureText: () => ({ mutateAsync: mocks.captureText, isPending: false }),
  useCaptureLink: () => ({ mutateAsync: mocks.captureLink, isPending: false }),
  useCaptureVoice: () => ({ mutateAsync: mocks.captureVoice, isPending: false }),
  useCaptureImage: () => ({ mutateAsync: mocks.captureImage, isPending: false })
}))

vi.mock('@/contexts/settings-modal-context', () => ({
  useSettingsModal: () => ({ open: mocks.openSettings })
}))

vi.mock('@/lib/voice-recording-readiness', () => ({
  ensureVoiceRecordingReady: (...args: unknown[]) => mocks.ensureReady(...args),
  getVoiceRecordingSettingsTarget: (readiness: { reason?: string }) =>
    readiness.reason === 'missing-model' ? 'ai:voice-local-model' : 'ai'
}))

vi.mock('@/lib/voice-memo-audio', () => ({
  prepareVoiceMemoAudio: (...args: unknown[]) => mocks.prepareAudio(...args)
}))

vi.mock('./voice-recorder', () => ({
  VoiceRecorder: forwardRef(
    (
      {
        onRecordingComplete,
        onCancel,
        className
      }: {
        onRecordingComplete: (blob: Blob, duration: number) => void
        onCancel: () => void
        className?: string
      },
      ref
    ) => {
      useImperativeHandle(ref, () => ({ start: mocks.recorderStart }))
      return (
        <div data-testid="voice-recorder" className={className}>
          <button
            type="button"
            onClick={() => onRecordingComplete(new Blob(['audio'], { type: 'audio/webm' }), 31)}
          >
            complete voice
          </button>
          <button type="button" onClick={onCancel}>
            cancel voice
          </button>
        </div>
      )
    }
  )
}))

describe('CaptureInput', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.captureText.mockResolvedValue({ success: true })
    mocks.captureLink.mockResolvedValue({ success: true })
    mocks.captureVoice.mockResolvedValue({ success: true })
    mocks.captureImage.mockResolvedValue({ success: true })
    mocks.ensureReady.mockResolvedValue(true)
    mocks.prepareAudio.mockResolvedValue({
      data: new ArrayBuffer(4),
      duration: 12,
      format: 'webm'
    })
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('captures notes, shows duplicate recovery, and supports force submit', async () => {
    const user = userEvent.setup()
    const onCaptureSuccess = vi.fn()
    mocks.captureText
      .mockResolvedValueOnce({
        duplicate: true,
        existingItem: {
          id: 'existing',
          title: 'Existing captured thought',
          createdAt: '2026-05-10T00:00:00.000Z'
        }
      })
      .mockResolvedValueOnce({ success: true })

    render(<CaptureInput onCaptureSuccess={onCaptureSuccess} />)

    fireEvent.change(screen.getByLabelText('captureInput'), {
      target: { value: 'First line\nsecond line' }
    })
    await user.click(screen.getByRole('button', { name: 'captureNote' }))

    await waitFor(() =>
      expect(mocks.captureText).toHaveBeenCalledWith({
        content: 'First line\nsecond line',
        title: 'First line...',
        force: false,
        source: 'inline'
      })
    )
    // One ICU message carries the title — no split HTML entity, no fragments.
    expect(screen.getByText('duplicateNotice:title=Existing captured thought')).toBeInTheDocument()
    // The duplicate is unresolved, so the text has to survive in the field.
    expect(screen.getByLabelText('captureInput')).toHaveValue('First line\nsecond line')

    await user.click(screen.getByRole('button', { name: 'captureAnyway' }))

    await waitFor(() =>
      expect(mocks.captureText).toHaveBeenLastCalledWith({
        content: 'First line\nsecond line',
        title: 'First line...',
        force: true,
        source: 'inline'
      })
    )
    expect(onCaptureSuccess).toHaveBeenCalledTimes(1)
    await waitFor(() => expect(screen.getByLabelText('captureInput')).toHaveValue(''))
  })

  it('normalizes URL captures and reports failed results', async () => {
    const user = userEvent.setup()
    const onCaptureError = vi.fn()
    mocks.captureLink.mockResolvedValueOnce({ success: false, error: new Error('network down') })

    render(<CaptureInput onCaptureError={onCaptureError} />)

    await user.type(screen.getByLabelText('captureInput'), 'example.com/path')
    await user.click(screen.getByRole('button', { name: 'captureLink' }))

    await waitFor(() =>
      expect(mocks.captureLink).toHaveBeenCalledWith({
        url: 'https://example.com/path',
        force: false,
        source: 'inline'
      })
    )
    expect(onCaptureError).toHaveBeenCalledWith('network down')
  })

  it('captures supported attachments and rejects unsupported file types', async () => {
    const onCaptureSuccess = vi.fn()
    const onCaptureError = vi.fn()
    const { container } = render(
      <CaptureInput onCaptureSuccess={onCaptureSuccess} onCaptureError={onCaptureError} />
    )
    const input = container.querySelector('input[type="file"]') as HTMLInputElement

    const image = new File(['image-bytes'], 'image.png', { type: 'image/png' })
    Object.defineProperty(image, 'arrayBuffer', {
      value: vi.fn().mockResolvedValue(new ArrayBuffer(4))
    })
    fireEvent.change(input, { target: { files: [image] } })

    await waitFor(() =>
      expect(mocks.captureImage).toHaveBeenCalledWith({
        data: expect.any(ArrayBuffer),
        filename: 'image.png',
        mimeType: 'image/png',
        source: 'inline'
      })
    )
    expect(onCaptureSuccess).toHaveBeenCalledTimes(1)

    const zip = new File(['zip'], 'archive.zip', { type: 'application/zip' })
    fireEvent.change(input, { target: { files: [zip] } })
    expect(onCaptureError).toHaveBeenCalledWith('Unsupported file type: application/zip')
  })

  it('places voice recording inline on the right side of the input', async () => {
    const user = userEvent.setup()

    render(<CaptureInput />)

    await user.click(screen.getByRole('button', { name: 'recordVoiceMemo' }))

    const inputShell = screen.getByTestId('capture-bar-shell')
    const recorderSlot = screen.getByTestId('capture-bar-recorder')

    await waitFor(() => {
      expect(inputShell).toHaveClass('w-[60%]')
      expect(recorderSlot).toHaveClass('w-[40%]')
      expect(recorderSlot).toHaveClass('opacity-100')
      expect(recorderSlot).toHaveClass('translate-x-0')
    })
  })

  it('keeps the voice recorder mounted while the stop transition exits', async () => {
    vi.useFakeTimers()
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime })

    render(<CaptureInput />)

    await user.click(screen.getByRole('button', { name: 'recordVoiceMemo' }))
    await user.click(screen.getByRole('button', { name: 'cancel voice' }))

    const recorderSlot = screen.getByTestId('capture-bar-recorder')

    expect(recorderSlot).toHaveClass('w-0')
    expect(recorderSlot).toHaveClass('opacity-0')
    expect(recorderSlot).toHaveClass('translate-x-2')

    act(() => {
      vi.advanceTimersByTime(250)
    })

    expect(screen.queryByTestId('voice-recorder')).not.toBeInTheDocument()
    vi.useRealTimers()
  })

  it('checks readiness, starts the recorder, captures prepared audio, and cancels recording', async () => {
    const user = userEvent.setup()
    const onCaptureSuccess = vi.fn()

    render(<CaptureInput onCaptureSuccess={onCaptureSuccess} />)

    await user.click(screen.getByRole('button', { name: 'recordVoiceMemo' }))
    expect(mocks.ensureReady).toHaveBeenCalledWith(expect.any(Function))
    expect(mocks.recorderStart).toHaveBeenCalledTimes(1)

    await user.click(screen.getByRole('button', { name: 'complete voice' }))

    await waitFor(() =>
      expect(mocks.captureVoice).toHaveBeenCalledWith({
        data: expect.any(ArrayBuffer),
        duration: 31,
        format: 'webm',
        transcribe: true,
        source: 'inline'
      })
    )
    expect(onCaptureSuccess).toHaveBeenCalledTimes(1)

    await user.click(screen.getByRole('button', { name: 'recordVoiceMemo' }))
    await user.click(screen.getByRole('button', { name: 'cancel voice' }))
    await waitFor(() =>
      expect(screen.queryByRole('button', { name: 'cancel voice' })).not.toBeInTheDocument()
    )
  })

  it('opens AI settings instead of recording when voice capture is not ready', async () => {
    const user = userEvent.setup()
    mocks.ensureReady.mockImplementationOnce(async (openSettings: (readiness: unknown) => void) => {
      openSettings({
        ready: false,
        provider: 'local',
        reason: 'missing-model'
      })
      return false
    })

    render(<CaptureInput />)

    await user.click(screen.getByRole('button', { name: 'recordVoiceMemo' }))

    expect(mocks.openSettings).toHaveBeenCalledWith('ai:voice-local-model')
    expect(mocks.recorderStart).not.toHaveBeenCalled()
  })
})
