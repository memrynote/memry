import { act, render } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { useVoiceCapture, type VoiceCapture } from './use-voice-capture'

/**
 * Mirrors real browser ordering: `MediaRecorder` is started without a timeslice,
 * so the whole recording arrives as a single `dataavailable` fired *after*
 * `stop()` returns, immediately followed by `onstop`.
 */
class MockMediaRecorder {
  static isTypeSupported = vi.fn(() => true)
  static instances: MockMediaRecorder[] = []

  state: 'inactive' | 'recording' = 'inactive'
  ondataavailable: ((event: { data: Blob }) => void) | null = null
  onstop: (() => void) | null = null
  onerror: ((event: unknown) => void) | null = null

  constructor(
    public stream: MediaStream,
    public options: MediaRecorderOptions
  ) {
    MockMediaRecorder.instances.push(this)
  }

  start(): void {
    this.state = 'recording'
  }

  stop(): void {
    this.state = 'inactive'
    queueMicrotask(() => {
      this.ondataavailable?.({ data: new Blob(['voice-audio'], { type: 'audio/webm' }) })
      this.onstop?.()
    })
  }
}

describe('useVoiceCapture cancel', () => {
  const prepareVoiceMemoAudio = vi.fn()
  const captureVoice = vi.fn()
  const transcribeAudio = vi.fn()
  const onError = vi.fn()
  const trackStop = vi.fn()
  const getUserMedia = vi.fn()

  // Stands in for what every voice surface does with a delivered blob: decode +
  // WAV encode, then the vault write and the transcription request.
  const onComplete = vi.fn((audioBlob: Blob, duration: number) => {
    void (async () => {
      const prepared = await prepareVoiceMemoAudio(audioBlob)
      await captureVoice({ ...prepared, duration, transcribe: true })
      await transcribeAudio(prepared)
    })()
  })

  const capture: { current: VoiceCapture | null } = { current: null }

  function Harness(): null {
    capture.current = useVoiceCapture({ onComplete, onError })
    return null
  }

  beforeEach(() => {
    vi.clearAllMocks()
    MockMediaRecorder.instances = []
    capture.current = null

    Object.defineProperty(navigator, 'mediaDevices', {
      configurable: true,
      value: { getUserMedia }
    })
    Object.defineProperty(globalThis, 'MediaRecorder', {
      configurable: true,
      value: MockMediaRecorder
    })

    getUserMedia.mockResolvedValue({ getTracks: () => [{ stop: trackStop }] })
    prepareVoiceMemoAudio.mockResolvedValue({
      data: new ArrayBuffer(8),
      duration: 3,
      format: 'wav'
    })
    captureVoice.mockResolvedValue({ success: true })
    transcribeAudio.mockResolvedValue({ success: true, text: 'hello' })
  })

  async function startRecording(): Promise<{ unmount: () => void }> {
    const view = render(<Harness />)
    await act(async () => {
      await capture.current?.start()
    })
    return view
  }

  /** Lets the queued `dataavailable`/`onstop` callbacks run. */
  async function flushRecorder(): Promise<void> {
    await act(async () => {
      await Promise.resolve()
      await Promise.resolve()
    })
  }

  it('never delivers, writes, or transcribes a cancelled recording', async () => {
    await startRecording()

    act(() => capture.current?.cancel())
    await flushRecorder()

    expect(onComplete).not.toHaveBeenCalled()
    expect(prepareVoiceMemoAudio).not.toHaveBeenCalled()
    expect(captureVoice).not.toHaveBeenCalled()
    expect(transcribeAudio).not.toHaveBeenCalled()
    expect(capture.current?.state).toBe('idle')
  })

  it('releases the microphone when a recording is cancelled', async () => {
    await startRecording()

    act(() => capture.current?.cancel())
    await flushRecorder()

    expect(trackStop).toHaveBeenCalled()
    expect(capture.current?.stream).toBeNull()
  })

  it('discards the recording when cancel lands while a stop is already in flight', async () => {
    await startRecording()

    act(() => {
      capture.current?.stop()
      capture.current?.cancel()
    })
    await flushRecorder()

    expect(onComplete).not.toHaveBeenCalled()
    expect(captureVoice).not.toHaveBeenCalled()
    expect(transcribeAudio).not.toHaveBeenCalled()
  })

  it('drops audio that arrives after unmounting mid-recording', async () => {
    const { unmount } = await startRecording()

    act(() => unmount())
    await flushRecorder()

    expect(onComplete).not.toHaveBeenCalled()
    expect(captureVoice).not.toHaveBeenCalled()
    expect(transcribeAudio).not.toHaveBeenCalled()
  })

  it('still delivers a recording that was stopped normally', async () => {
    await startRecording()

    act(() => capture.current?.stop())
    await flushRecorder()

    expect(onComplete).toHaveBeenCalledTimes(1)
    expect(onComplete.mock.calls[0][0]).toBeInstanceOf(Blob)
    expect(prepareVoiceMemoAudio).toHaveBeenCalled()
    expect(captureVoice).toHaveBeenCalled()
    expect(transcribeAudio).toHaveBeenCalled()
  })

  it('delivers a fresh recording started after a cancelled one', async () => {
    await startRecording()

    act(() => capture.current?.cancel())
    await flushRecorder()
    expect(onComplete).not.toHaveBeenCalled()

    await act(async () => {
      await capture.current?.start()
    })
    act(() => capture.current?.stop())
    await flushRecorder()

    expect(onComplete).toHaveBeenCalledTimes(1)
  })
})
