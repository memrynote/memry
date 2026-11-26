// oxlint-disable-next-line import/default -- Vite's `?worker&url` suffix default-exports the bundled worklet's URL; the linter cannot resolve the query import
import workletUrl from './pcm-capture-worklet.ts?worker&url'
import {
  PCM_CAPTURE_PROCESSOR,
  type PcmCaptureCommand,
  type PcmCaptureMessage
} from './pcm-capture-protocol'

/** A worklet that never answers `stop` (a suspended or dead audio thread) still ends the recording. */
export const PCM_CAPTURE_STOP_DEADLINE_MS = 2000

export interface PcmCapture {
  /**
   * Flushes the worklet, then resolves with the mono recording, or null when it holds no samples.
   * Past `PCM_CAPTURE_STOP_DEADLINE_MS` it resolves with the samples received so far.
   */
  stop: () => Promise<AudioBuffer | null>
  /** Tears the graph down and drops the samples; a pending `stop` resolves null. */
  cancel: () => void
}

/**
 * Records `stream` as mono float PCM at the context's rate through an AudioWorklet. The three
 * Tauri webviews differ in the containers their MediaRecorder writes, and PCM needs no decode
 * before `prepareVoiceMemoAudio` resamples it to 16 kHz.
 * `onFailure` reports a processor error; the caller cancels.
 */
export async function startPcmCapture(
  stream: MediaStream,
  onFailure: (cause: unknown) => void
): Promise<PcmCapture> {
  const context = new AudioContext()
  try {
    await context.audioWorklet.addModule(workletUrl)
    const source = context.createMediaStreamSource(stream)
    // One silent output into the destination: WebKit only pulls a node that reaches it.
    const node = new AudioWorkletNode(context, PCM_CAPTURE_PROCESSOR, {
      numberOfInputs: 1,
      numberOfOutputs: 1,
      outputChannelCount: [1]
    })
    const chunks: Float32Array<ArrayBuffer>[] = []
    let finish: ((audio: AudioBuffer | null) => void) | null = null
    let closed = false

    const teardown = (): void => {
      if (closed) return
      closed = true
      source.disconnect()
      node.disconnect()
      void context.close()
    }

    const toAudioBuffer = (): AudioBuffer | null => {
      const length = chunks.reduce((frames, chunk) => frames + chunk.length, 0)
      if (length === 0) return null
      const audio = new AudioBuffer({ length, numberOfChannels: 1, sampleRate: context.sampleRate })
      let offset = 0
      for (const chunk of chunks) {
        audio.copyToChannel(chunk, 0, offset)
        offset += chunk.length
      }
      chunks.length = 0
      return audio
    }

    const finishWithSamples = (): void => {
      const audio = toAudioBuffer()
      teardown()
      finish?.(audio)
    }

    // oxlint-disable-next-line unicorn/prefer-add-event-listener -- assigning `onmessage` starts the port; a listener would also need `port.start()`
    node.port.onmessage = (event: MessageEvent<PcmCaptureMessage>) => {
      if (closed) return
      if (event.data.type === 'samples') {
        chunks.push(event.data.samples)
        return
      }
      finishWithSamples()
    }
    node.addEventListener('processorerror', (event) => {
      if (!closed) onFailure(event)
    })

    source.connect(node)
    node.connect(context.destination)
    // Not awaited: a webview that never resumes must not hold `start` with the mic open. Such a
    // recording holds no samples, and its `stop` resolves null at the deadline.
    if (context.state === 'suspended') context.resume().catch(onFailure)

    return {
      stop: () =>
        new Promise((resolve) => {
          if (closed) return resolve(null)
          finish = resolve
          const command: PcmCaptureCommand = { type: 'stop' }
          // oxlint-disable-next-line unicorn/require-post-message-target-origin -- MessagePort.postMessage takes no target origin
          node.port.postMessage(command)
          setTimeout(() => {
            if (!closed) finishWithSamples()
          }, PCM_CAPTURE_STOP_DEADLINE_MS)
        }),
      cancel: () => {
        chunks.length = 0
        teardown()
        finish?.(null)
      }
    }
  } catch (err) {
    void context.close()
    throw err
  }
}
