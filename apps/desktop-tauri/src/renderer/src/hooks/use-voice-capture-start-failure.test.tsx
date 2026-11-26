import { act, renderHook } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { fakePcm } from '@tests/utils/fake-pcm-capture'

import { useVoiceCapture } from './use-voice-capture'

vi.mock(
  '@/lib/pcm-capture',
  async () => (await import('@tests/utils/fake-pcm-capture')).pcmCaptureModule
)

/**
 * A failed capture start is a privacy bug, not just a leak: `getUserMedia`
 * already turned the microphone on, so every track has to be stopped before the
 * hook goes back to idle or the OS keeps recording with no UI saying so.
 */

interface FakeTrack {
  readyState: 'live' | 'ended'
  stop: ReturnType<typeof vi.fn>
}

interface FakeStream {
  tracks: FakeTrack[]
  stream: MediaStream
}

function createFakeStream(): FakeStream {
  const tracks: FakeTrack[] = [
    { readyState: 'live', stop: vi.fn() },
    { readyState: 'live', stop: vi.fn() }
  ]

  for (const track of tracks) {
    track.stop.mockImplementation(() => {
      track.readyState = 'ended'
    })
  }

  return { tracks, stream: { getTracks: () => tracks } as unknown as MediaStream }
}

describe('useVoiceCapture — failed capture start releases the microphone', () => {
  const onComplete = vi.fn()
  const onError = vi.fn()
  const getUserMedia = vi.fn()

  beforeEach(() => {
    vi.clearAllMocks()
    fakePcm.reset()

    Object.defineProperty(navigator, 'mediaDevices', {
      configurable: true,
      value: { getUserMedia }
    })
  })

  it.each([
    [
      'the capture graph throws a TypeError',
      new TypeError("Failed to construct 'AudioWorkletNode': node name is not defined"),
      'start-failed'
    ],
    [
      'the worklet module fails to load',
      new DOMException('Unable to load a worklet', 'AbortError'),
      'access-failed'
    ]
  ])('stops every acquired track when %s', async (_label, failure, expectedKind) => {
    const first = createFakeStream()
    getUserMedia.mockResolvedValue(first.stream)
    fakePcm.nextFailure = failure

    const { result } = renderHook(() => useVoiceCapture({ onComplete, onError }))

    await act(async () => {
      await result.current.start()
    })

    expect(onError).toHaveBeenCalledWith(expect.objectContaining({ kind: expectedKind }))

    // The mic must be off: every track of the stream we acquired is stopped.
    for (const track of first.tracks) {
      expect(track.stop).toHaveBeenCalledTimes(1)
      expect(track.readyState).toBe('ended')
    }

    // And the hook must be back to a retryable idle state, not mid-recording.
    expect(result.current.state).toBe('idle')
    expect(result.current.stream).toBeNull()

    // A second attempt still works and drives a fresh stream end to end.
    const second = createFakeStream()
    getUserMedia.mockResolvedValue(second.stream)

    await act(async () => {
      await result.current.start()
    })

    expect(getUserMedia).toHaveBeenCalledTimes(2)
    expect(result.current.state).toBe('recording')
    expect(result.current.stream).toBe(second.stream)
    expect(second.tracks.every((track) => track.readyState === 'live')).toBe(true)

    act(() => {
      result.current.cancel()
    })

    expect(second.tracks.every((track) => track.readyState === 'ended')).toBe(true)
  })

  it('never overwrites the stream ref while its tracks are still live', async () => {
    const first = createFakeStream()
    getUserMedia.mockResolvedValue(first.stream)

    const { result } = renderHook(() => useVoiceCapture({ onComplete, onError }))

    await act(async () => {
      await result.current.start()
    })

    expect(first.tracks.every((track) => track.readyState === 'live')).toBe(true)

    // Starting again replaces `streamRef`; the previous stream would otherwise
    // become unreachable and stay hot for the life of the window.
    const second = createFakeStream()
    getUserMedia.mockResolvedValue(second.stream)

    await act(async () => {
      await result.current.start()
    })

    expect(first.tracks.every((track) => track.readyState === 'ended')).toBe(true)
    expect(result.current.stream).toBe(second.stream)

    act(() => {
      result.current.cancel()
    })

    expect(second.tracks.every((track) => track.readyState === 'ended')).toBe(true)
  })
})
