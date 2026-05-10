import { beforeEach, describe, expect, it, vi } from 'vitest'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import type React from 'react'
import { QuickCapture } from './quick-capture'

const mocks = vi.hoisted(() => ({
  captureText: vi.fn(),
  captureLink: vi.fn(),
  captureImage: vi.fn(),
  captureVoice: vi.fn(),
  ensureVoiceReady: vi.fn(),
  prepareAudio: vi.fn(),
  previewLink: vi.fn(),
  close: vi.fn(),
  resize: vi.fn(),
  getClipboard: vi.fn(),
  openSettings: vi.fn()
}))

vi.mock('@memry/i18n/renderer', () => ({
  useT: () => ({ t: (key: string) => key })
}))

vi.mock('react-i18next', () => ({
  getI18n: () => ({
    getFixedT: () => (key: string) => key
  })
}))

vi.mock('@/lib/logger', () => ({
  createLogger: () => ({ error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() })
}))

vi.mock('@/hooks/use-inbox', () => ({
  useCaptureText: () => ({ mutateAsync: mocks.captureText }),
  useCaptureLink: () => ({ mutateAsync: mocks.captureLink }),
  useCaptureImage: () => ({ mutateAsync: mocks.captureImage }),
  useCaptureVoice: () => ({ mutateAsync: mocks.captureVoice })
}))

vi.mock('@/lib/voice-recording-readiness', () => ({
  ensureVoiceRecordingReady: mocks.ensureVoiceReady
}))

vi.mock('@/lib/voice-memo-audio', () => ({
  prepareVoiceMemoAudio: mocks.prepareAudio
}))

vi.mock('./quick-capture-input', () => ({
  QuickCaptureInput: ({
    value,
    onChange,
    onSubmit,
    onStartRecording,
    onPaste,
    detectedType,
    isCapturing,
    hasAttachment,
    textareaRef
  }: {
    value: string
    onChange: (value: string) => void
    onSubmit: () => void
    onStartRecording: () => void
    onPaste: (event: React.ClipboardEvent) => void
    detectedType: string
    isCapturing: boolean
    hasAttachment: boolean
    textareaRef: React.RefObject<HTMLTextAreaElement | null>
  }) => (
    <div>
      <textarea
        ref={textareaRef}
        aria-label="quick input"
        value={value}
        onChange={(event) => onChange(event.target.value)}
        onPaste={onPaste}
      />
      <span data-testid="detected-type">{detectedType}</span>
      <span data-testid="capture-flags">
        {isCapturing ? 'capturing' : 'idle'}:{hasAttachment ? 'attachment' : 'empty'}
      </span>
      <button type="button" onClick={onSubmit}>
        submit
      </button>
      <button type="button" onClick={onStartRecording}>
        record
      </button>
    </div>
  )
}))

vi.mock('./voice-recorder', async () => {
  const React = await import('react')
  return {
    VoiceRecorder: React.forwardRef(
      (
        {
          onRecordingComplete,
          onCancel
        }: {
          onRecordingComplete: (blob: Blob, duration: number) => void
          onCancel: () => void
        },
        ref
      ) => {
        React.useImperativeHandle(ref, () => ({ start: vi.fn() }))
        return (
          <div data-testid="voice-recorder">
            <button
              type="button"
              onClick={() => onRecordingComplete(new Blob(['voice'], { type: 'audio/webm' }), 7)}
            >
              complete recording
            </button>
            <button type="button" onClick={onCancel}>
              cancel recording
            </button>
          </div>
        )
      }
    )
  }
})

vi.mock('./quick-capture-footer', () => ({
  QuickCaptureFooter: () => <div data-testid="footer">footer</div>
}))

vi.mock('./quick-capture-states', () => ({
  CaptureSuccess: ({ onAutoClose }: { onAutoClose: () => void }) => (
    <button type="button" onClick={onAutoClose}>
      captured
    </button>
  ),
  CaptureError: ({ message, onDismiss }: { message: string; onDismiss: () => void }) => (
    <div role="alert">
      {message}
      <button type="button" onClick={onDismiss}>
        dismiss
      </button>
    </div>
  ),
  CaptureDuplicate: ({
    title,
    onForce,
    onClose
  }: {
    title: string
    onForce: () => void
    onClose: () => void
  }) => (
    <div>
      duplicate {title}
      <button type="button" onClick={onForce}>
        force
      </button>
      <button type="button" onClick={onClose}>
        close duplicate
      </button>
    </div>
  )
}))

vi.mock('./quick-capture-link-preview', () => ({
  LinkPreviewCard: ({
    title,
    domain,
    loading
  }: {
    title: string
    domain: string
    loading: boolean
  }) => <div data-testid="link-preview">{loading ? 'loading' : `${title}:${domain}`}</div>
}))

vi.mock('./quick-capture-image-preview', () => ({
  formatFileSize: (size: number) => `${size} B`,
  FilePreviewCard: ({
    variant,
    title,
    subtitle,
    onClear
  }: {
    variant: string
    title: string
    subtitle: string
    onClear: () => void
  }) => (
    <div data-testid={`file-${variant}`}>
      {title}:{subtitle}
      <button type="button" onClick={onClear}>
        clear file
      </button>
    </div>
  )
}))

vi.mock('./social-card', () => ({
  detectPlatformFromUrl: (url: string) => (url.includes('x.com') ? 'twitter' : 'web'),
  extractHandleFromUrl: () => '@kaan'
}))

describe('QuickCapture', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.clearAllMocks()
    mocks.captureText.mockResolvedValue({ success: true })
    mocks.captureLink.mockResolvedValue({ success: true })
    mocks.captureImage.mockResolvedValue({ success: true })
    mocks.captureVoice.mockResolvedValue({ success: true })
    mocks.ensureVoiceReady.mockResolvedValue(true)
    mocks.prepareAudio.mockResolvedValue({
      data: new ArrayBuffer(4),
      duration: 8,
      format: 'webm'
    })
    mocks.previewLink.mockResolvedValue({ title: 'Preview', domain: 'example.com' })
    mocks.getClipboard.mockResolvedValue('')
    vi.stubGlobal(
      'ResizeObserver',
      class {
        observe = vi.fn()
        disconnect = vi.fn()
      }
    )
    vi.stubGlobal('URL', {
      createObjectURL: vi.fn(() => 'blob:test'),
      revokeObjectURL: vi.fn()
    })
    vi.stubGlobal('navigator', {
      clipboard: {
        read: vi.fn().mockRejectedValue(new Error('no clipboard'))
      }
    })
    const api = (window as any).api
    api.inbox = { previewLink: mocks.previewLink }
    api.quickCapture = {
      close: mocks.close,
      resize: mocks.resize,
      getClipboard: mocks.getClipboard,
      openSettings: mocks.openSettings
    }
  })

  it('prefills clipboard text and captures notes', async () => {
    mocks.getClipboard.mockResolvedValue('Ship coverage\nwith focused tests')

    render(<QuickCapture />)
    await act(async () => {
      vi.runOnlyPendingTimers()
      await Promise.resolve()
    })

    expect(screen.getByLabelText('quick input')).toHaveValue('Ship coverage\nwith focused tests')

    fireEvent.click(screen.getByText('submit'))
    await waitFor(() =>
      expect(mocks.captureText).toHaveBeenCalledWith({
        content: 'Ship coverage\nwith focused tests',
        title: 'Ship coverage...',
        force: false,
        source: 'quick-capture'
      })
    )

    fireEvent.click(await screen.findByText('captured'))
    expect(mocks.close).toHaveBeenCalled()
  })

  it('captures links, shows preview, and handles duplicate force capture', async () => {
    mocks.captureLink
      .mockResolvedValueOnce({
        duplicate: true,
        existingItem: { id: 'dup', title: 'Existing link', createdAt: '2026-01-01' }
      })
      .mockResolvedValueOnce({ success: true })

    render(<QuickCapture />)
    fireEvent.change(screen.getByLabelText('quick input'), { target: { value: 'example.com' } })

    expect(screen.getByTestId('detected-type')).toHaveTextContent('link')
    await act(async () => {
      vi.advanceTimersByTime(500)
      await Promise.resolve()
    })
    await waitFor(() => expect(screen.getByTestId('link-preview')).toHaveTextContent('Preview'))

    fireEvent.click(screen.getByText('submit'))
    await screen.findByText(/duplicate Existing link/)
    fireEvent.click(screen.getByText('force'))

    await waitFor(() =>
      expect(mocks.captureLink).toHaveBeenLastCalledWith({
        url: 'https://example.com',
        force: true,
        source: 'quick-capture'
      })
    )
  })

  it('captures pasted images and dropped PDFs, and reports unsupported drops', async () => {
    const { unmount } = render(<QuickCapture />)
    const image = Object.assign(new File(['image'], 'shot.png', { type: 'image/png' }), {
      arrayBuffer: vi.fn().mockResolvedValue(new ArrayBuffer(5))
    })

    fireEvent.paste(screen.getByLabelText('quick input'), {
      clipboardData: {
        items: [{ type: 'image/png', getAsFile: () => image }]
      }
    })

    expect(screen.getByTestId('detected-type')).toHaveTextContent('image')
    expect(screen.getByTestId('file-image')).toHaveTextContent('clipboard-')

    fireEvent.click(screen.getByText('submit'))
    await waitFor(() =>
      expect(mocks.captureImage).toHaveBeenCalledWith(
        expect.objectContaining({ filename: expect.stringContaining('clipboard-') })
      )
    )

    unmount()
    const fresh = render(<QuickCapture />)

    const pdf = new File(['pdf'], 'brief.pdf', { type: 'application/pdf' })
    fireEvent.drop(fresh.container.firstElementChild as Element, {
      dataTransfer: { files: [pdf] }
    })
    expect(screen.getByTestId('detected-type')).toHaveTextContent('pdf')
    expect(screen.getByTestId('file-pdf')).toHaveTextContent('brief.pdf')

    const unsupported = new File(['x'], 'bad.txt', { type: 'text/plain' })
    fireEvent.drop(fresh.container.firstElementChild as Element, {
      dataTransfer: { files: [unsupported] }
    })
    expect(screen.getByRole('alert')).toHaveTextContent('Unsupported file type: text/plain')
    fireEvent.click(screen.getByText('dismiss'))
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })

  it('loads clipboard images on mount, clears attachments, and reports image capture failures', async () => {
    const clipboardBlob = Object.assign(new Blob(['clipboard'], { type: 'image/png' }), {
      arrayBuffer: vi.fn().mockResolvedValue(new ArrayBuffer(6))
    })
    ;(navigator.clipboard.read as ReturnType<typeof vi.fn>).mockResolvedValue([
      {
        types: ['text/plain', 'image/png'],
        getType: vi.fn().mockResolvedValue(clipboardBlob)
      }
    ])
    mocks.captureImage.mockResolvedValue({ success: false, error: new Error('upload failed') })

    render(<QuickCapture />)
    await act(async () => {
      vi.runOnlyPendingTimers()
      await Promise.resolve()
    })

    expect(screen.getByTestId('detected-type')).toHaveTextContent('image')
    expect(screen.getByTestId('file-image')).toHaveTextContent('clipboard-')

    fireEvent.click(screen.getByText('submit'))
    await screen.findByRole('alert')
    expect(screen.getByRole('alert')).toHaveTextContent('upload failed')

    fireEvent.click(screen.getByText('dismiss'))
    fireEvent.click(screen.getByText('clear file'))
    expect(screen.getByTestId('detected-type')).toHaveTextContent('note')
    expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:test')
  })

  it('handles text, link, recording, and preview failures without leaving stale errors', async () => {
    mocks.previewLink.mockRejectedValue(new Error('preview failed'))
    mocks.captureText.mockResolvedValueOnce({ success: false, error: 'note failed' })
    mocks.captureLink.mockResolvedValueOnce({ success: false, error: 'link failed' })
    mocks.captureVoice.mockResolvedValueOnce({ success: false, error: 'voice failed' })

    render(<QuickCapture />)

    fireEvent.change(screen.getByLabelText('quick input'), { target: { value: 'plain note' } })
    fireEvent.click(screen.getByText('submit'))
    expect(await screen.findByRole('alert')).toHaveTextContent('note failed')

    fireEvent.change(screen.getByLabelText('quick input'), { target: { value: 'example.org' } })
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()

    await act(async () => {
      vi.advanceTimersByTime(500)
      await Promise.resolve()
    })
    await waitFor(() => expect(screen.queryByTestId('link-preview')).not.toBeInTheDocument())

    fireEvent.click(screen.getByText('submit'))
    expect(await screen.findByRole('alert')).toHaveTextContent('link failed')

    await act(async () => {
      fireEvent.click(screen.getByText('record'))
      await Promise.resolve()
    })
    await screen.findByTestId('voice-recorder')
    fireEvent.click(screen.getByText('cancel recording'))
    expect(screen.queryByTestId('voice-recorder')).not.toBeInTheDocument()

    await act(async () => {
      fireEvent.click(screen.getByText('record'))
      await Promise.resolve()
    })
    await screen.findByTestId('voice-recorder')
    fireEvent.click(screen.getByText('complete recording'))
    expect(await screen.findByRole('alert')).toHaveTextContent('voice failed')
  })

  it('handles selected and dropped audio readiness plus capture errors', async () => {
    mocks.ensureVoiceReady.mockResolvedValueOnce(false).mockResolvedValueOnce(true)
    mocks.captureVoice.mockResolvedValueOnce({ success: false, error: 'audio failed' })

    const { container } = render(<QuickCapture />)

    const selectedAudio = new File(['audio'], 'memo.webm', { type: 'audio/webm' })
    await act(async () => {
      window.dispatchEvent(
        new CustomEvent('quick-capture:file-selected', { detail: selectedAudio })
      )
    })
    await waitFor(() => expect(screen.getByTestId('detected-type')).toHaveTextContent('voice'))

    await act(async () => {
      fireEvent.click(screen.getByText('submit'))
      await Promise.resolve()
    })
    await waitFor(() => expect(mocks.ensureVoiceReady).toHaveBeenCalledTimes(1))
    expect(mocks.captureVoice).not.toHaveBeenCalled()
    await waitFor(() => expect(screen.getByTestId('capture-flags')).toHaveTextContent('idle'))

    await act(async () => {
      fireEvent.click(screen.getByText('submit'))
      await Promise.resolve()
    })
    await waitFor(() => expect(mocks.captureVoice).toHaveBeenCalledTimes(1))
    expect(await screen.findByRole('alert')).toHaveTextContent('audio failed')

    mocks.ensureVoiceReady.mockResolvedValue(true)
    mocks.captureVoice.mockResolvedValue({ success: true })
    const droppedAudio = new File(['audio'], 'memo.mp3', { type: 'audio/mp3' })
    fireEvent.drop(container.firstElementChild as Element, {
      dataTransfer: { files: [droppedAudio] }
    })
    fireEvent.click(screen.getByText('submit'))
    await waitFor(() => expect(mocks.captureVoice).toHaveBeenCalledTimes(2))
  })

  it('records voice, captures social URLs, and closes on Escape', async () => {
    render(<QuickCapture />)

    fireEvent.change(screen.getByLabelText('quick input'), {
      target: { value: 'https://x.com/kaan' }
    })
    expect(screen.getByTestId('detected-type')).toHaveTextContent('social')
    expect(screen.getByTestId('file-social')).toHaveTextContent('@kaan')

    await act(async () => {
      fireEvent.click(screen.getByText('record'))
      await Promise.resolve()
    })
    await screen.findByTestId('voice-recorder')
    fireEvent.click(screen.getByText('complete recording'))
    await waitFor(() =>
      expect(mocks.captureVoice).toHaveBeenCalledWith(
        expect.objectContaining({ duration: 7, format: 'webm', transcribe: true })
      )
    )

    fireEvent.keyDown(window, { key: 'Escape' })
    expect(mocks.close).toHaveBeenCalled()
  })
})
