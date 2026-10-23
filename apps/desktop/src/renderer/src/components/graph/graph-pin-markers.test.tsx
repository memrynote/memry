import { render } from '@testing-library/react'
import Graph from 'graphology'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { GraphPinMarkers } from './graph-pin-markers'

const ctx = {
  setTransform: vi.fn(),
  clearRect: vi.fn(),
  beginPath: vi.fn(),
  arc: vi.fn(),
  stroke: vi.fn(),
  strokeStyle: '',
  lineWidth: 0
}

const mocks = vi.hoisted(() => ({ sigma: null as null | Record<string, any> }))

vi.mock('@react-sigma/core', () => ({ useSigma: () => mocks.sigma }))

function makeSigma(graph: Graph): Record<string, any> {
  const canvases: Record<string, HTMLCanvasElement> = {}
  const listeners = new Map<string, () => void>()
  return {
    getGraph: () => graph,
    createCanvasContext: vi.fn((id: string) => {
      const canvas = document.createElement('canvas')
      canvas.getContext = vi.fn(() => ctx) as unknown as HTMLCanvasElement['getContext']
      canvases[id] = canvas
    }),
    getCanvases: () => canvases,
    killLayer: vi.fn((id: string) => delete canvases[id]),
    getDimensions: () => ({ width: 200, height: 100 }),
    getNodeDisplayData: (id: string) => {
      const attrs = graph.getNodeAttributes(id)
      return { x: attrs.x, y: attrs.y, size: attrs.size, hidden: attrs.hidden === true }
    },
    framedGraphToViewport: ({ x, y }: { x: number; y: number }) => ({ x: x * 2, y: y * 2 }),
    scaleSize: (size: number) => size,
    on: vi.fn((event: string, fn: () => void) => listeners.set(event, fn)),
    off: vi.fn((event: string) => listeners.delete(event)),
    listeners
  }
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe('GraphPinMarkers', () => {
  it('rings only visible pinned nodes and redraws after every render', () => {
    const graph = new Graph()
    graph.addNode('pinned', { x: 10, y: 20, size: 4, pinned: true })
    graph.addNode('free', { x: 0, y: 0, size: 4 })
    graph.addNode('hidden', { x: 5, y: 5, size: 4, pinned: true, hidden: true })
    const sigma = makeSigma(graph)
    mocks.sigma = sigma

    const { unmount } = render(<GraphPinMarkers graph={graph} color="#123456" />)

    expect(ctx.arc).toHaveBeenCalledTimes(1)
    expect(ctx.arc).toHaveBeenCalledWith(20, 40, 6.5, 0, 2 * Math.PI)
    expect(ctx.strokeStyle).toBe('#123456')

    sigma.listeners.get('afterRender')?.()
    expect(ctx.arc).toHaveBeenCalledTimes(2)

    unmount()
    expect(sigma.off).toHaveBeenCalledWith('afterRender', expect.any(Function))
    expect(sigma.killLayer).toHaveBeenCalledWith('pinMarkers')
  })

  it('does nothing on a sigma instance bound to another graph', () => {
    const graph = new Graph()
    const sigma = makeSigma(new Graph())
    mocks.sigma = sigma

    render(<GraphPinMarkers graph={graph} color="#000" />)

    expect(sigma.createCanvasContext).not.toHaveBeenCalled()
  })
})
