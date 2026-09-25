import { describe, expect, it, vi } from 'vitest'

// sigma reads WebGL constants at import time; jsdom has no WebGL. Only `scaleSize`
// and the default settings are used here, never a GL program.
vi.hoisted(() => {
  vi.stubGlobal('WebGLRenderingContext', class {})
  vi.stubGlobal('WebGL2RenderingContext', class {})
})

import Sigma from 'sigma'
import { DEFAULT_SETTINGS, type Settings } from 'sigma/settings'
import type { GraphDataResponse } from '@memry/contracts/graph-api'

import { buildGraphologyGraph } from './graph-builder'
import { graphLabelRenderedSizeThreshold } from './graph-labels'

// Camera ratio: 1 is the fitted default view, below 1 is zoomed in, above 1 zoomed out.
const DEFAULT_ZOOM = 1
const ZOOM_IN_2X = 0.5
const ZOOM_OUT_4X = 4

function graphNode(
  id: string,
  connectionCount: number,
  isUnresolved = false
): GraphDataResponse['nodes'][number] {
  return {
    id,
    type: 'note',
    label: id,
    tags: [],
    wordCount: 0,
    connectionCount,
    emoji: null,
    color: '#888888',
    isOrphan: connectionCount === 0,
    isUnresolved
  }
}

const graph = buildGraphologyGraph(
  {
    nodes: [graphNode('hub', 8), graphNode('leaf', 1), graphNode('ghost', 0, true)],
    edges: []
  },
  { showTags: false }
)

function nodeSize(node: string): number {
  return graph.getNodeAttribute(node, 'size') as number
}

/**
 * Sigma's own size gate from `renderLabels`: a label without `forceLabel` is skipped
 * when `scaleSize(size) < labelRenderedSizeThreshold`. `scaleSize` runs on a stand-in
 * `this` because a real Sigma instance needs WebGL; the canvas keeps sigma's
 * `zoomToSizeRatioFunction` and `itemSizesReference` defaults.
 */
function passesLabelSizeGate(node: string, cameraRatio: number, showLabels: boolean): boolean {
  const settings: Settings = { ...DEFAULT_SETTINGS }
  const sigmaState = {
    settings,
    graphToViewportRatio: 1,
    getSetting: <K extends keyof Settings>(key: K): Settings[K] => settings[key]
  }
  const renderedSize = Sigma.prototype.scaleSize.call(sigmaState, nodeSize(node), cameraRatio)
  return renderedSize >= graphLabelRenderedSizeThreshold(showLabels)
}

describe('graphLabelRenderedSizeThreshold', () => {
  it('keeps the node sizes this test relies on', () => {
    expect(nodeSize('hub')).toBe(9)
    expect(nodeSize('leaf')).toBe(3)
    expect(nodeSize('ghost')).toBe(2)
  })

  it('makes every node label-eligible after a 2x zoom when labels are on', () => {
    for (const node of ['hub', 'leaf', 'ghost']) {
      expect(passesLabelSizeGate(node, ZOOM_IN_2X, true)).toBe(true)
    }
  })

  it('lets resolved leaf nodes compete for a label at the default zoom', () => {
    expect(passesLabelSizeGate('hub', DEFAULT_ZOOM, true)).toBe(true)
    expect(passesLabelSizeGate('leaf', DEFAULT_ZOOM, true)).toBe(true)
    expect(passesLabelSizeGate('ghost', DEFAULT_ZOOM, true)).toBe(false)
  })

  it('drops small-node labels first when zoomed out', () => {
    expect(passesLabelSizeGate('hub', ZOOM_OUT_4X, true)).toBe(true)
    expect(passesLabelSizeGate('leaf', ZOOM_OUT_4X, true)).toBe(false)
    expect(passesLabelSizeGate('ghost', ZOOM_OUT_4X, true)).toBe(false)
  })

  it('keeps labels hover-only at any zoom when labels are off', () => {
    for (const cameraRatio of [ZOOM_OUT_4X, DEFAULT_ZOOM, ZOOM_IN_2X, 0.01]) {
      for (const node of ['hub', 'leaf', 'ghost']) {
        expect(passesLabelSizeGate(node, cameraRatio, false)).toBe(false)
      }
    }
  })
})
