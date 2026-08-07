import React from 'react'
import { act, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { VoiceRecorder, type VoiceRecorderHandle } from './voice-recorder'

class MockMediaRecorder {
  static isTypeSupported = vi.fn(() => true)

  state: 'inactive' | 'recording' = 'inactive'
  ondataavailable: ((event: { data: Blob }) => void) | null = null
  onstop: (() => void) | null = null
  onerror: ((event: unknown) => void) | null = null

  constructor(
    public stream: MediaStream,
    public options: MediaRecorderOptions
  ) {}

  start(): void {
    this.state = 'recording'
  }

  stop(): void {
    this.state = 'inactive'
    queueMicrotask(() => {
      this.ondataavailable?.({ data: new Blob(['voice'], { type: 'audio/webm' }) })
      this.onstop?.()
    })
  }
}

class MockAudioContext {
  createMediaStreamSource = vi.fn(() => ({ connect: vi.fn() }))
  createAnalyser = vi.fn(() => ({
    fftSize: 2048,
    getByteTimeDomainData: vi.fn((array: Uint8Array) => array.fill(128))
  }))
  close = vi.fn().mockResolvedValue(undefined)
}

describe('VoiceRecorder', () => {
  const onRecordingComplete = vi.fn()
  const onCancel = vi.fn()
  const trackStop = vi.fn()
  const getUserMedia = vi.fn()

  beforeEach(() => {
    vi.clearAllMocks()

    Object.defineProperty(navigator, 'mediaDevices', {
      configurable: true,
      value: { getUserMedia }
    })

    Object.defineProperty(globalThis, 'MediaRecorder', {
      configurable: true,
      value: MockMediaRecorder
    })

    Object.defineProperty(globalThis, 'AudioContext', {
      configurable: true,
      value: MockAudioContext
    })

    Object.defineProperty(globalThis, 'requestAnimationFrame', {
      configurable: true,
      value: vi.fn(() => 1)
    })

    Object.defineProperty(globalThis, 'cancelAnimationFrame', {
      configurable: true,
      value: vi.fn()
    })

    getUserMedia.mockResolvedValue({
      getTracks: () => [{ stop: trackStop }]
    })
  })

  it('starts recording, stops, and returns the captured blob', async () => {
    render(<VoiceRecorder onRecordingComplete={onRecordingComplete} onCancel={onCancel} />)

    await userEvent.click(screen.getByLabelText('Start voice recording'))

    expect(getUserMedia).toHaveBeenCalledWith({
      audio: {
        echoCancellation: true,
        noiseSuppression: true,
        sampleRate: 44100
      }
    })
    expect(await screen.findByLabelText('Stop recording')).toBeInTheDocument()

    await userEvent.click(screen.getByLabelText('Stop recording'))

    await waitFor(() => expect(onRecordingComplete).toHaveBeenCalled())
    const [blob, duration] = onRecordingComplete.mock.calls[0]
    expect(blob).toBeInstanceOf(Blob)
    expect(blob.type).toBe('audio/webm')
    expect(duration).toEqual(expect.any(Number))
    expect(trackStop).toHaveBeenCalled()
  })

  it('keeps the active recording controls within an inline header height', async () => {
    render(
      <VoiceRecorder
        className="h-full w-full"
        onRecordingComplete={onRecordingComplete}
        onCancel={onCancel}
      />
    )

    await userEvent.click(screen.getByLabelText('Start voice recording'))

    const recordingShell = (await screen.findByLabelText('Stop recording')).parentElement

    expect(recordingShell).toHaveClass('max-h-10')
    expect(recordingShell).toHaveClass('py-1.5')
    expect(recordingShell).toHaveClass('overflow-hidden')
    expect(recordingShell).not.toHaveClass('py-2.5')
  })

  // The recorder runs without a timeslice, so a real browser always emits the
  // whole recording *after* stop() — cancel has to survive that late blob.
  it('cancels an active recording and clears chunks', async () => {
    render(<VoiceRecorder onRecordingComplete={onRecordingComplete} onCancel={onCancel} />)

    await userEvent.click(screen.getByLabelText('Start voice recording'))
    await userEvent.click(await screen.findByLabelText('Cancel recording'))

    expect(onCancel).toHaveBeenCalled()
    expect(trackStop).toHaveBeenCalled()
    expect(onRecordingComplete).not.toHaveBeenCalled()
    expect(screen.getByLabelText('Start voice recording')).toBeInTheDocument()
  })

  it('surfaces permission denial and opens the settings guidance', async () => {
    getUserMedia.mockRejectedValue(new DOMException('blocked', 'NotAllowedError'))

    render(<VoiceRecorder onRecordingComplete={onRecordingComplete} onCancel={onCancel} />)

    await userEvent.click(screen.getByLabelText('Start voice recording'))

    expect(await screen.findByText('Microphone access denied')).toBeInTheDocument()

    await userEvent.click(screen.getByRole('button', { name: /settings/i }))

    expect(
      screen.getByText('Enable microphone access in your system settings, then try again.')
    ).toBeInTheDocument()

    await userEvent.click(screen.getByRole('button', { name: '' }))
    expect(onCancel).toHaveBeenCalled()
  })

  it('supports imperative start and handles missing microphones', async () => {
    getUserMedia.mockRejectedValue(new DOMException('missing', 'NotFoundError'))
    const ref = React.createRef<VoiceRecorderHandle>()

    render(
      <VoiceRecorder ref={ref} onRecordingComplete={onRecordingComplete} onCancel={onCancel} />
    )

    await act(async () => {
      await ref.current?.start()
    })

    expect(await screen.findByText('No microphone found')).toBeInTheDocument()
  })
})
