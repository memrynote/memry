import { createRef } from 'react'
import { act, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { QuickCaptureFooter } from './quick-capture-footer'
import { FilePreviewCard, formatFileSize } from './quick-capture-image-preview'
import { QuickCaptureInput } from './quick-capture-input'
import { LinkPreviewCard } from './quick-capture-link-preview'
import { CaptureDuplicate, CaptureError, CaptureSuccess } from './quick-capture-states'

vi.mock('@memry/i18n/renderer', () => ({
  useT: () => ({
    t: (key: string, values?: Record<string, unknown>) =>
      values
        ? `${key}(${Object.entries(values)
            .map(([name, value]) => `${name}=${String(value)}`)
            .join(', ')})`
        : key
  })
}))

describe('quick capture child components', () => {
  let closeMock: ReturnType<typeof vi.fn>

  beforeEach(() => {
    closeMock = vi.fn()
    const existingApi = (window as any).api
    existingApi.quickCapture = existingApi.quickCapture ?? {}
    existingApi.quickCapture.close = closeMock
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  it('submits, closes, records, pastes, and dispatches selected files from the input', () => {
    const onChange = vi.fn()
    const onSubmit = vi.fn()
    const onStartRecording = vi.fn()
    const onPaste = vi.fn()
    const dispatchSpy = vi.spyOn(window, 'dispatchEvent')
    const textareaRef = createRef<HTMLTextAreaElement>()
    const file = new File(['pdf'], 'research.pdf', { type: 'application/pdf' })

    const { container } = render(
      <QuickCaptureInput
        value="draft"
        onChange={onChange}
        onSubmit={onSubmit}
        onStartRecording={onStartRecording}
        onPaste={onPaste}
        detectedType="pdf"
        isCapturing={false}
        hasAttachment={false}
        textareaRef={textareaRef}
      />
    )

    const textarea = screen.getByLabelText(
      'phaseF.componentsQuickCaptureInput.quickCaptureInput'
    ) as HTMLTextAreaElement
    fireEvent.change(textarea, { target: { value: 'updated' } })
    fireEvent.paste(textarea)
    fireEvent.keyDown(textarea, { key: 'Enter', metaKey: true })
    fireEvent.keyDown(textarea, { key: 'Escape' })
    fireEvent.click(screen.getByLabelText('phaseF.componentsQuickCaptureInput.recordVoiceMemo'))

    const input = container.querySelector('input[type="file"]') as HTMLInputElement
    Object.defineProperty(input, 'files', { configurable: true, value: [file] })
    fireEvent.change(input)

    expect(onChange).toHaveBeenCalledWith('updated')
    expect(onPaste).toHaveBeenCalledTimes(1)
    expect(onSubmit).toHaveBeenCalledTimes(1)
    expect(closeMock).toHaveBeenCalledTimes(1)
    expect(onStartRecording).toHaveBeenCalledTimes(1)
    expect(dispatchSpy).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'quick-capture:file-selected', detail: file })
    )
    expect(input.value).toBe('')
  })

  it('disables input actions while a capture is in flight', () => {
    const onSubmit = vi.fn()
    const onStartRecording = vi.fn()

    render(
      <QuickCaptureInput
        value=""
        onChange={vi.fn()}
        onSubmit={onSubmit}
        onStartRecording={onStartRecording}
        onPaste={vi.fn()}
        detectedType="voice"
        isCapturing={true}
        hasAttachment={true}
        textareaRef={createRef<HTMLTextAreaElement>()}
      />
    )

    const textarea = screen.getByLabelText('phaseF.componentsQuickCaptureInput.quickCaptureInput')
    expect(textarea).toBeDisabled()
    expect(
      screen.getByLabelText('phaseF.componentsQuickCaptureInput.recordVoiceMemo')
    ).toBeDisabled()
    expect(screen.getByLabelText('phaseF.componentsQuickCaptureInput.attachFile')).toBeDisabled()
  })

  it('renders footer shortcuts and quick capture states', () => {
    vi.useFakeTimers()
    const onAutoClose = vi.fn()
    const onDismiss = vi.fn()
    const onForce = vi.fn()
    const onClose = vi.fn()

    const { rerender } = render(<QuickCaptureFooter className="custom-footer" />)
    expect(screen.getByText('Esc')).toBeInTheDocument()
    expect(screen.getByText('phaseF.componentsQuickCaptureFooter.close')).toBeInTheDocument()
    expect(screen.getByText('phaseF.componentsQuickCaptureFooter.capture')).toBeInTheDocument()

    rerender(<CaptureSuccess onAutoClose={onAutoClose} />)
    act(() => {
      vi.advanceTimersByTime(1000)
    })
    expect(onAutoClose).toHaveBeenCalledTimes(1)

    rerender(<CaptureError message="Network failed" onDismiss={onDismiss} />)
    expect(screen.getByText('Network failed')).toBeInTheDocument()
    fireEvent.click(screen.getByLabelText('phaseF.componentsQuickCaptureStates.dismissError'))
    expect(onDismiss).toHaveBeenCalledTimes(1)

    rerender(
      <CaptureDuplicate
        title="A title that is long enough to be truncated when rendered in the duplicate warning"
        createdAt="2026-05-10T12:00:00Z"
        onForce={onForce}
        onClose={onClose}
      />
    )
    const expectedDate = new Date('2026-05-10T12:00:00Z').toLocaleDateString(undefined, {
      month: 'short',
      day: 'numeric'
    })
    expect(
      screen.getByText(
        `phaseF.componentsQuickCaptureStates.duplicateMeta(title=A title that is long enough to be truncated when rendered in..., date=${expectedDate})`
      )
    ).toBeInTheDocument()
    fireEvent.click(screen.getByText('phaseF.componentsQuickCaptureStates.captureAnyway'))
    fireEvent.click(screen.getByText('phaseF.componentsQuickCaptureStates.close'))
    expect(onForce).toHaveBeenCalledTimes(1)
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('formats file sizes and renders preview cards for each attachment variant', () => {
    const onClear = vi.fn()

    expect(formatFileSize(999)).toBe('999 B')
    expect(formatFileSize(2048)).toBe('2 KB')
    expect(formatFileSize(2.5 * 1024 * 1024)).toBe('2.5 MB')

    const { rerender } = render(
      <FilePreviewCard variant="image" title="diagram.png" subtitle="999 B" onClear={onClear} />
    )
    expect(screen.getByText('IMAGE')).toBeInTheDocument()

    rerender(
      <FilePreviewCard
        variant="pdf"
        title="brief.pdf"
        subtitle="2 KB"
        initial="B"
        onClear={onClear}
      />
    )
    expect(screen.getByText('PDF')).toBeInTheDocument()
    expect(screen.getByText('B')).toBeInTheDocument()

    rerender(<FilePreviewCard variant="social" title="post" subtitle="x.com" onClear={onClear} />)
    fireEvent.click(
      screen.getByLabelText('phaseF.componentsQuickCaptureImagePreview.removeAttachment')
    )
    expect(screen.getByText('SOCIAL')).toBeInTheDocument()
    expect(onClear).toHaveBeenCalledTimes(1)
  })

  it('renders link preview loading, favicon, and fallback states', () => {
    const { container, rerender } = render(
      <LinkPreviewCard title="" domain="example.com" loading={true} />
    )
    expect(container.querySelectorAll('.animate-pulse')).toHaveLength(3)

    rerender(
      <LinkPreviewCard title="Example" domain="example.com" favicon="https://example.com/f.ico" />
    )
    const image = container.querySelector('img') as HTMLImageElement
    const fallback = screen.getByText('E').parentElement as HTMLElement

    expect(image).toBeInTheDocument()
    expect(fallback).toHaveClass('hidden')

    fireEvent.error(image)
    expect(image.style.display).toBe('none')
    expect(fallback).not.toHaveClass('hidden')
    expect(screen.getByText('phaseF.componentsQuickCaptureLinkPreview.link')).toBeInTheDocument()
  })
})
