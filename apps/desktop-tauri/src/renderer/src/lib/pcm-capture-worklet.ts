// Runs in the AudioWorkletGlobalScope, loaded by `pcm-capture.ts` through Vite's `?worker&url`.
// TypeScript's DOM lib has no worklet scope, so its two globals are declared here.
import {
  PCM_CAPTURE_CHUNK_FRAMES,
  PCM_CAPTURE_PROCESSOR,
  type PcmCaptureCommand,
  type PcmCaptureMessage
} from './pcm-capture-protocol'

declare abstract class AudioWorkletProcessor {
  readonly port: MessagePort
  abstract process(inputs: Float32Array[][]): boolean
}
declare function registerProcessor(name: string, processor: new () => AudioWorkletProcessor): void

/** Downmixes the microphone input to mono and posts it in fixed-size chunks. */
class PcmCaptureProcessor extends AudioWorkletProcessor {
  private chunk = new Float32Array(PCM_CAPTURE_CHUNK_FRAMES)
  private filled = 0
  private stopped = false

  constructor() {
    super()
    // oxlint-disable-next-line unicorn/prefer-add-event-listener -- assigning `onmessage` starts the port; a listener would also need `port.start()`
    this.port.onmessage = (event: MessageEvent<PcmCaptureCommand>) => {
      if (event.data.type !== 'stop' || this.stopped) return
      this.stopped = true
      this.flush()
      this.post({ type: 'done' })
    }
  }

  process(inputs: Float32Array[][]): boolean {
    if (this.stopped) return false
    const channels = inputs[0] ?? []
    const frames = channels[0]?.length ?? 0
    for (let frame = 0; frame < frames; frame += 1) {
      let sum = 0
      for (const channel of channels) sum += channel[frame] ?? 0
      this.chunk[this.filled] = sum / channels.length
      this.filled += 1
      if (this.filled === this.chunk.length) this.flush()
    }
    return true
  }

  private flush(): void {
    if (this.filled === 0) return
    const samples = this.chunk.slice(0, this.filled)
    this.filled = 0
    this.post({ type: 'samples', samples }, [samples.buffer])
  }

  private post(message: PcmCaptureMessage, transfer: Transferable[] = []): void {
    this.port.postMessage(message, transfer)
  }
}

registerProcessor(PCM_CAPTURE_PROCESSOR, PcmCaptureProcessor)
