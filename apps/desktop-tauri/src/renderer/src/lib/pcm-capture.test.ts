import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { PCM_CAPTURE_PROCESSOR, type PcmCaptureMessage } from './pcm-capture-protocol'
import { PCM_CAPTURE_STOP_DEADLINE_MS, startPcmCapture } from './pcm-capture'

vi.mock('./pcm-capture-worklet.ts?worker&url', () => ({
  default: '/assets/pcm-capture-worklet.js'
}))

const SAMPLE_RATE = 48_000

/** Answers `stop` as the worklet does: queued chunks first, then `done`, after the call returns. */
class FakeWorkletNode {
  static instances: FakeWorkletNode[] = []
  pending: Float32Array[] = []
  /** A dead audio thread: `stop` is never answered. */
  silent = false
  connect = vi.fn()
  disconnect = vi.fn()
  listeners = new Map<string, (event: Event) => void>()
  addEventListener = vi.fn((type: string, listener: (event: Event) => void) => {
    this.listeners.set(type, listener)
  })
  port = {
    onmessage: null as ((event: { data: PcmCaptureMessage }) => void) | null,
    postMessage: vi.fn((command: { type: string }) => {
      if (command.type !== 'stop' || this.silent) return
      queueMicrotask(() => {
        for (const samples of this.pending)
          this.port.onmessage?.({ data: { type: 'samples', samples } })
        this.port.onmessage?.({ data: { type: 'done' } })
      })
    })
  }

  constructor(
    public context: FakeAudioContext,
    public name: string,
    public options: AudioWorkletNodeOptions
  ) {
    FakeWorkletNode.instances.push(this)
  }
}

class FakeAudioContext {
  static instances: FakeAudioContext[] = []
  static addModuleFailure: Error | null = null
  static initialState: AudioContextState = 'running'
  sampleRate = SAMPLE_RATE
  state: AudioContextState = FakeAudioContext.initialState
  destination = {}
  source = { connect: vi.fn(), disconnect: vi.fn() }
  audioWorklet = {
    addModule: vi.fn(async () => {
      if (FakeAudioContext.addModuleFailure) throw FakeAudioContext.addModuleFailure
    })
  }
  createMediaStreamSource = vi.fn(() => this.source)
  resume = vi.fn(async () => {
    this.state = 'running'
  })
  close = vi.fn(async () => {
    this.state = 'closed'
  })

  constructor() {
    FakeAudioContext.instances.push(this)
  }
}

class FakeAudioBuffer {
  data: Float32Array
  sampleRate: number
  numberOfChannels: number

  constructor(options: AudioBufferOptions) {
    this.data = new Float32Array(options.length)
    this.sampleRate = options.sampleRate
    this.numberOfChannels = options.numberOfChannels ?? 1
  }

  copyToChannel(source: Float32Array, channel: number, offset: number): void {
    if (channel !== 0) throw new RangeError(`mono buffer has no channel ${channel}`)
    this.data.set(source, offset)
  }
}

const stream = {} as MediaStream

async function start(onFailure = vi.fn()) {
  const capture = await startPcmCapture(stream, onFailure)
  return {
    capture,
    context: FakeAudioContext.instances[0],
    node: FakeWorkletNode.instances[0],
    onFailure
  }
}

describe('startPcmCapture', () => {
  beforeEach(() => {
    FakeAudioContext.instances = []
    FakeAudioContext.addModuleFailure = null
    FakeAudioContext.initialState = 'running'
    FakeWorkletNode.instances = []
    vi.stubGlobal('AudioContext', FakeAudioContext)
    vi.stubGlobal('AudioWorkletNode', FakeWorkletNode)
    vi.stubGlobal('AudioBuffer', FakeAudioBuffer)
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })

  it('wires the microphone through the worklet into a silent destination', async () => {
    const { context, node } = await start()

    expect(context.audioWorklet.addModule).toHaveBeenCalledWith('/assets/pcm-capture-worklet.js')
    expect(context.createMediaStreamSource).toHaveBeenCalledWith(stream)
    expect(node.name).toBe(PCM_CAPTURE_PROCESSOR)
    expect(context.source.connect).toHaveBeenCalledWith(node)
    expect(node.connect).toHaveBeenCalledWith(context.destination)
  })

  it('resumes a context the webview created suspended', async () => {
    FakeAudioContext.initialState = 'suspended'
    const { context } = await start()

    expect(context.resume).toHaveBeenCalledTimes(1)
  })

  it('reports a refused resume without holding the start', async () => {
    FakeAudioContext.initialState = 'suspended'
    const refusal = new DOMException('resume refused', 'NotAllowedError')
    const resume = vi.fn(async () => {
      throw refusal
    })
    vi.stubGlobal(
      'AudioContext',
      class extends FakeAudioContext {
        resume = resume
      }
    )

    const { onFailure } = await start()
    await Promise.resolve()

    expect(resume).toHaveBeenCalledTimes(1)
    expect(onFailure).toHaveBeenCalledWith(refusal)
  })

  it('joins the chunks in capture order into one mono buffer at the context rate', async () => {
    const { capture, context, node } = await start()
    node.pending = [Float32Array.of(0.1, 0.2), Float32Array.of(0.3), Float32Array.of(-0.4, 0.5)]

    const audio = (await capture.stop()) as unknown as FakeAudioBuffer

    expect(audio.sampleRate).toBe(SAMPLE_RATE)
    expect(audio.numberOfChannels).toBe(1)
    expect(Array.from(audio.data)).toEqual(Array.from(Float32Array.of(0.1, 0.2, 0.3, -0.4, 0.5)))
    expect(context.source.disconnect).toHaveBeenCalledTimes(1)
    expect(node.disconnect).toHaveBeenCalledTimes(1)
    expect(context.close).toHaveBeenCalledTimes(1)
  })

  it('resolves null for a recording with no samples', async () => {
    const { capture, context } = await start()

    await expect(capture.stop()).resolves.toBeNull()
    expect(context.close).toHaveBeenCalledTimes(1)
  })

  it('drops the samples on cancel, even with a stop in flight', async () => {
    const { capture, context, node } = await start()
    node.pending = [Float32Array.of(0.1)]

    const stopping = capture.stop()
    capture.cancel()
    // The graph goes at once, not when the worklet's late `done` arrives.
    expect(context.close).toHaveBeenCalledTimes(1)
    expect(node.disconnect).toHaveBeenCalledTimes(1)

    await expect(stopping).resolves.toBeNull()
    await expect(capture.stop()).resolves.toBeNull()
    expect(context.close).toHaveBeenCalledTimes(1)
  })

  it('ends the recording with the samples received when the worklet never answers stop', async () => {
    vi.useFakeTimers()
    const { capture, context, node } = await start()
    node.silent = true
    node.port.onmessage?.({ data: { type: 'samples', samples: Float32Array.of(0.25, -0.25) } })

    let settled: AudioBuffer | null | undefined
    void capture.stop().then((audio) => (settled = audio))
    await vi.advanceTimersByTimeAsync(PCM_CAPTURE_STOP_DEADLINE_MS - 1)
    expect(settled).toBeUndefined()

    await vi.advanceTimersByTimeAsync(1)

    expect(Array.from((settled as unknown as FakeAudioBuffer).data)).toEqual([0.25, -0.25])
    expect(context.close).toHaveBeenCalledTimes(1)
  })

  it('closes the context and rethrows when the worklet module fails to load', async () => {
    const failure = new DOMException('Unable to load a worklet', 'AbortError')
    FakeAudioContext.addModuleFailure = failure

    await expect(startPcmCapture(stream, vi.fn())).rejects.toBe(failure)
    expect(FakeAudioContext.instances[0].close).toHaveBeenCalledTimes(1)
    expect(FakeWorkletNode.instances).toHaveLength(0)
  })

  it('reports a processor error to the caller', async () => {
    const { node, onFailure } = await start()
    const event = new Event('processorerror')

    node.listeners.get('processorerror')?.(event)

    expect(onFailure).toHaveBeenCalledWith(event)
  })
})
