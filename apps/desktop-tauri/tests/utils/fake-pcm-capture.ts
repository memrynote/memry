import type { PcmCapture } from '@/lib/pcm-capture'

/**
 * Stand-in for `@/lib/pcm-capture` in jsdom, which has no Web Audio. Install it with
 * `vi.mock('@/lib/pcm-capture', async () => (await import('@tests/utils/fake-pcm-capture')).pcmCaptureModule)`.
 * `stop()` resolves a microtask later, as the worklet's `done` message arrives after the call.
 */
export interface FakePcmSession {
  stream: MediaStream
  stopCalls: number
  cancelled: boolean
  /** Raises a processor error, as `AudioWorkletNode.onprocessorerror` does. */
  fail: (cause: unknown) => void
}

export function fakeAudioBuffer(duration: number): AudioBuffer {
  return { duration, sampleRate: 48_000, numberOfChannels: 1 } as unknown as AudioBuffer
}

export const fakePcm = {
  sessions: [] as FakePcmSession[],
  /** Thrown by the next `startPcmCapture`, then cleared. */
  nextFailure: null as unknown,
  /** Holds the next `startPcmCapture` until the returned function is called. */
  gate: null as Promise<void> | null,
  /** What `stop()` resolves with; null is an empty recording. */
  recording: fakeAudioBuffer(1) as AudioBuffer | null,
  reset(): void {
    this.sessions = []
    this.nextFailure = null
    this.gate = null
    this.recording = fakeAudioBuffer(1)
  },
  holdNextStart(): () => void {
    let open = (): void => {}
    this.gate = new Promise((resolve) => (open = resolve))
    return open
  }
}

async function startPcmCapture(
  stream: MediaStream,
  onFailure: (cause: unknown) => void
): Promise<PcmCapture> {
  const gate = fakePcm.gate
  fakePcm.gate = null
  if (gate) await gate
  if (fakePcm.nextFailure !== null) {
    const failure = fakePcm.nextFailure
    fakePcm.nextFailure = null
    throw failure
  }
  const session: FakePcmSession = { stream, stopCalls: 0, cancelled: false, fail: onFailure }
  fakePcm.sessions.push(session)
  return {
    stop: async () => {
      session.stopCalls += 1
      await Promise.resolve()
      return session.cancelled ? null : fakePcm.recording
    },
    cancel: () => {
      session.cancelled = true
    }
  }
}

export const pcmCaptureModule = { startPcmCapture }
