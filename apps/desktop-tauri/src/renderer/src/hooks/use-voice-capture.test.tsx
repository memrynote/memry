import { act, render } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { fakePcm } from '@tests/utils/fake-pcm-capture'

import { useVoiceCapture, type VoiceCapture } from './use-voice-capture'

vi.mock(
  '@/lib/pcm-capture',
  async () => (await import('@tests/utils/fake-pcm-capture')).pcmCaptureModule
)

describe('useVoiceCapture cancel', () => {
  const prepareVoiceMemoAudio = vi.fn()
  const captureVoice = vi.fn()
  const transcribeAudio = vi.fn()
  const onError = vi.fn()
  const trackStop = vi.fn()
  const getUserMedia = vi.fn()

  // Stands in for what every voice surface does with a delivered recording: resample +
  // WAV encode, then the vault write and the transcription request.
  const onComplete = vi.fn((audio: AudioBuffer, duration: number) => {
    void (async () => {
      const prepared = await prepareVoiceMemoAudio(audio)
      await captureVoice({ ...prepared, duration, transcribe: true })
      await transcribeAudio(prepared)
    })()
  })

  const capture: { current: VoiceCapture | null } = { current: null }

  function Harness(): null {
    // oxlint-disable-next-line react/immutability -- test harness writes the latest hook result into a ref for assertions
    capture.current = useVoiceCapture({ onComplete, onError })
    return null
  }

  beforeEach(() => {
    vi.clearAllMocks()
    fakePcm.reset()
    capture.current = null

    Object.defineProperty(navigator, 'mediaDevices', {
      configurable: true,
      value: { getUserMedia }
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

  /** Lets the capture's pending `stop()` settle. */
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
    expect(onComplete.mock.calls[0][0]).toBe(fakePcm.recording)
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

  it('drops the capture and keeps the mic off when cancel lands while the graph is being built', async () => {
    const open = fakePcm.holdNextStart()
    render(<Harness />)

    let starting: Promise<void> | undefined
    act(() => {
      starting = capture.current?.start()
    })
    await act(async () => {
      await Promise.resolve()
    })
    act(() => capture.current?.cancel())
    await act(async () => {
      open()
      await starting
    })

    expect(trackStop).toHaveBeenCalled()
    expect(fakePcm.sessions).toHaveLength(1)
    expect(fakePcm.sessions[0].cancelled).toBe(true)
    expect(capture.current?.state).toBe('idle')
    expect(capture.current?.stream).toBeNull()
  })

  it('reports a processor error as recorder-failed and releases the microphone', async () => {
    await startRecording()

    const cause = new Event('processorerror')
    act(() => fakePcm.sessions[0].fail(cause))
    await flushRecorder()

    expect(onError).toHaveBeenCalledWith({ kind: 'recorder-failed', cause })
    expect(trackStop).toHaveBeenCalled()
    expect(fakePcm.sessions[0].cancelled).toBe(true)
    expect(onComplete).not.toHaveBeenCalled()
    expect(capture.current?.state).toBe('idle')
  })

  it('delivers nothing for a recording with no samples', async () => {
    fakePcm.recording = null
    await startRecording()

    act(() => capture.current?.stop())
    await flushRecorder()

    expect(onComplete).not.toHaveBeenCalled()
    expect(capture.current?.state).toBe('idle')
  })

  function holdPermission(): (granted: boolean) => void {
    let settle: (granted: boolean) => void = () => {}
    getUserMedia.mockReturnValueOnce(
      new Promise((resolve, reject) => {
        settle = (granted) =>
          granted
            ? resolve({ getTracks: () => [{ stop: trackStop }] })
            : reject(new DOMException('denied', 'NotAllowedError'))
      })
    )
    return settle
  }

  it('starts no capture when the surface unmounts while the permission prompt is open', async () => {
    const grant = holdPermission()
    const { unmount } = render(<Harness />)

    let starting: Promise<void> | undefined
    act(() => {
      starting = capture.current?.start()
    })
    act(() => unmount())
    await act(async () => {
      grant(true)
      await starting
    })

    expect(fakePcm.sessions).toHaveLength(0)
    expect(trackStop).toHaveBeenCalled()
    expect(onError).not.toHaveBeenCalled()
  })

  it('starts no capture and stays idle when cancelled while the permission prompt is open', async () => {
    const grant = holdPermission()
    render(<Harness />)

    let starting: Promise<void> | undefined
    act(() => {
      starting = capture.current?.start()
    })
    act(() => capture.current?.cancel())
    await act(async () => {
      grant(true)
      await starting
    })

    expect(fakePcm.sessions).toHaveLength(0)
    expect(trackStop).toHaveBeenCalled()
    expect(capture.current?.state).toBe('idle')
    expect(capture.current?.stream).toBeNull()
  })

  it('reports no error for a start abandoned before the prompt was refused', async () => {
    const answer = holdPermission()
    render(<Harness />)

    let starting: Promise<void> | undefined
    act(() => {
      starting = capture.current?.start()
    })
    act(() => capture.current?.cancel())
    await act(async () => {
      answer(false)
      await starting
    })

    expect(onError).not.toHaveBeenCalled()
    expect(capture.current?.state).toBe('idle')
  })

  it('treats a stop during the graph build as a cancel and goes back to idle', async () => {
    const open = fakePcm.holdNextStart()
    render(<Harness />)

    let starting: Promise<void> | undefined
    act(() => {
      starting = capture.current?.start()
    })
    await act(async () => {
      await Promise.resolve()
    })
    act(() => capture.current?.stop())
    await act(async () => {
      open()
      await starting
    })

    expect(capture.current?.state).toBe('idle')
    expect(fakePcm.sessions[0].cancelled).toBe(true)
    expect(trackStop).toHaveBeenCalled()
    expect(onComplete).not.toHaveBeenCalled()
  })

  it("does not let a replaced recording's timer end the new one", async () => {
    vi.useFakeTimers()
    try {
      await startRecording()
      await act(async () => {
        await vi.advanceTimersByTimeAsync(200_000)
      })
      await act(async () => {
        await capture.current?.start()
      })
      await act(async () => {
        await vi.advanceTimersByTimeAsync(150_000)
      })

      expect(capture.current?.state).toBe('recording')
      expect(fakePcm.sessions[1].stopCalls).toBe(0)
      expect(onComplete).not.toHaveBeenCalled()
    } finally {
      vi.useRealTimers()
    }
  })
})
