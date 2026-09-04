/**
 * A frame that lands after the graph's container is gone must not repaint.
 *
 * jsdom does no layout, so `offsetWidth` is stubbed to model the one rule that
 * matters here: an attached element measures, a detached one reads 0 — exactly
 * what the browser reports between React's mutation phase and the passive
 * cleanup that cancels the physics loop's animation frame. The fake Sigma
 * reproduces the real `resize()` contract from sigma 3.0.3, which throws on a
 * 0-width container instead of rendering.
 */
import { act, render } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { GraphDataResponse } from '@memry/contracts/graph-api'

const ZERO_WIDTH_ERROR =
  'Sigma: Container has no width. You can set the allowInvalidContainer setting to true to stop seeing this error.'

const mocks = vi.hoisted(() => ({
  localGraph: { data: null as GraphDataResponse | null, isLoading: false },
  refreshCount: 0
}))

vi.mock('sigma', () => {
  class FakeSigma {
    private readonly camera = {
      getState: () => ({ x: 0, y: 0, ratio: 1, angle: 0 }),
      setState: () => {}
    }

    constructor(
      public graph: unknown,
      public container: HTMLElement,
      public settings: Record<string, unknown>
    ) {}

    getGraph(): unknown {
      return this.graph
    }

    getContainer(): HTMLElement {
      return this.container
    }

    getCamera(): FakeSigma['camera'] {
      return this.camera
    }

    setSetting(key: string, value: unknown): void {
      this.settings = { ...this.settings, [key]: value }
    }

    refresh(): void {
      if (this.container.offsetWidth === 0) throw new Error(ZERO_WIDTH_ERROR)
      mocks.refreshCount += 1
    }

    kill(): void {}
  }

  return { Sigma: FakeSigma, default: FakeSigma }
})

vi.mock('@memry/i18n/renderer', () => ({
  useT: () => ({ t: (key: string) => key })
}))

vi.mock('next-themes', () => ({
  useTheme: () => ({ resolvedTheme: 'light' })
}))

vi.mock('@/hooks/use-graph-data', () => ({
  useLocalGraphData: () => mocks.localGraph
}))

vi.mock('./graph-events', () => ({
  GraphEvents: () => null
}))

const { LocalGraphPanel } = await import('./local-graph-panel')

const baseData: GraphDataResponse = {
  nodes: ['note-a', 'note-b'].map((id) => ({
    id,
    type: 'note' as const,
    label: id,
    tags: [],
    wordCount: 5,
    connectionCount: 1,
    emoji: null,
    color: '#888888',
    isOrphan: false,
    isUnresolved: false
  })),
  edges: [{ id: 'note-a-note-b', source: 'note-a', target: 'note-b', type: 'wikilink', weight: 1 }]
}

let frames = new Map<number, FrameRequestCallback>()
let nextFrameHandle = 0

function runFrames(count: number): void {
  act(() => {
    for (let i = 0; i < count; i++) {
      const next = frames.entries().next()
      if (next.done) return
      frames.delete(next.value[0])
      next.value[1](16 * (i + 1))
    }
  })
}

describe('LocalGraphPanel on a container with no width', () => {
  let offsetWidth: PropertyDescriptor | undefined

  beforeEach(() => {
    mocks.localGraph = { data: baseData, isLoading: false }
    mocks.refreshCount = 0
    frames = new Map()
    nextFrameHandle = 0
    offsetWidth = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'offsetWidth')
    Object.defineProperty(HTMLElement.prototype, 'offsetWidth', {
      configurable: true,
      get(this: HTMLElement) {
        return this.isConnected ? 800 : 0
      }
    })
    let seed = 0.13
    vi.spyOn(Math, 'random').mockImplementation(() => {
      seed = (seed * 9301 + 0.49297) % 1
      return seed
    })
    vi.spyOn(window, 'requestAnimationFrame').mockImplementation((callback) => {
      nextFrameHandle += 1
      frames.set(nextFrameHandle, callback)
      return nextFrameHandle
    })
    vi.spyOn(window, 'cancelAnimationFrame').mockImplementation((handle) => {
      frames.delete(handle)
    })
  })

  afterEach(() => {
    vi.restoreAllMocks()
    if (offsetWidth) Object.defineProperty(HTMLElement.prototype, 'offsetWidth', offsetWidth)
    else Reflect.deleteProperty(HTMLElement.prototype, 'offsetWidth')
  })

  function renderPanel(): HTMLElement {
    const host = document.createElement('div')
    document.body.appendChild(host)
    render(<LocalGraphPanel noteId="note-a" onClose={vi.fn()} />, { container: host })
    return host
  }

  it('repaints while the container is attached', () => {
    renderPanel()
    runFrames(3)

    expect(mocks.refreshCount).toBeGreaterThan(0)
  })

  it('does not throw when a queued frame lands after the container is detached', () => {
    const host = renderPanel()
    runFrames(1)
    const beforeDetach = mocks.refreshCount

    host.remove()

    expect(() => runFrames(3)).not.toThrow()
    expect(mocks.refreshCount).toBe(beforeDetach)
  })
})
