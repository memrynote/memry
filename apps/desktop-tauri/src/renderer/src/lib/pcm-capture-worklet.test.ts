import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  PCM_CAPTURE_CHUNK_FRAMES,
  PCM_CAPTURE_PROCESSOR,
  type PcmCaptureMessage
} from './pcm-capture-protocol'

/** One render quantum, the block size the audio thread hands `process`. */
const QUANTUM = 128

class FakePort {
  onmessage: ((event: { data: unknown }) => void) | null = null
  posted: PcmCaptureMessage[] = []

  postMessage(message: PcmCaptureMessage): void {
    this.posted.push(message)
  }
}

interface Processor {
  port: FakePort
  process: (inputs: Float32Array[][]) => boolean
}

/** Loads the worklet module the way `addModule` does: into a scope with the two worklet globals. */
async function loadProcessor(): Promise<Processor> {
  let registered: { name: string; ctor: new () => Processor } | null = null
  vi.stubGlobal(
    'AudioWorkletProcessor',
    class {
      port = new FakePort()
    }
  )
  vi.stubGlobal('registerProcessor', (name: string, ctor: new () => Processor) => {
    registered = { name, ctor }
  })
  vi.resetModules()
  await import('./pcm-capture-worklet')
  const { name, ctor } = registered as unknown as { name: string; ctor: new () => Processor }
  expect(name).toBe(PCM_CAPTURE_PROCESSOR)
  return new ctor()
}

function quantum(value: number): Float32Array {
  return new Float32Array(QUANTUM).fill(value)
}

function postedSamples(port: FakePort): number[] {
  return port.posted.flatMap((message) =>
    message.type === 'samples' ? Array.from(message.samples) : []
  )
}

describe('pcm capture worklet', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('downmixes to mono and posts one message per full chunk', async () => {
    const processor = await loadProcessor()
    const quantaPerChunk = PCM_CAPTURE_CHUNK_FRAMES / QUANTUM

    for (let index = 0; index < quantaPerChunk - 1; index += 1) {
      expect(processor.process([[quantum(1), quantum(0)]])).toBe(true)
    }
    expect(processor.port.posted).toHaveLength(0)

    processor.process([[quantum(1), quantum(0)]])

    expect(processor.port.posted).toHaveLength(1)
    const samples = postedSamples(processor.port)
    expect(samples).toHaveLength(PCM_CAPTURE_CHUNK_FRAMES)
    expect(samples.every((sample) => sample === 0.5)).toBe(true)
  })

  it('flushes the partial chunk on stop, then reports done and stops processing', async () => {
    const processor = await loadProcessor()
    processor.process([[quantum(0.25)]])
    processor.process([[quantum(-0.25)]])

    processor.port.onmessage?.({ data: { type: 'stop' } })

    expect(processor.port.posted.map((message) => message.type)).toEqual(['samples', 'done'])
    expect(postedSamples(processor.port)).toEqual([
      ...Array<number>(QUANTUM).fill(0.25),
      ...Array<number>(QUANTUM).fill(-0.25)
    ])
    expect(processor.process([[quantum(1)]])).toBe(false)

    processor.port.onmessage?.({ data: { type: 'stop' } })
    expect(processor.port.posted).toHaveLength(2)
  })

  it('reports done without samples when nothing was captured', async () => {
    const processor = await loadProcessor()
    // An input with no channels: the track ended or is not connected yet.
    expect(processor.process([[]])).toBe(true)
    expect(processor.process([])).toBe(true)

    processor.port.onmessage?.({ data: { type: 'stop' } })

    expect(processor.port.posted).toEqual([{ type: 'done' }])
  })
})
