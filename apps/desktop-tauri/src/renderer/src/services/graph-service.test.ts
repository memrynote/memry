import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { GraphDataResponse, GraphLayout } from '@memry/contracts/graph-api'

const mocks = vi.hoisted(() => ({
  invoke: vi.fn(),
  commands: {
    graphGetLayout: vi.fn(),
    graphSaveLayout: vi.fn(),
    graphClearLayout: vi.fn()
  }
}))

vi.mock('@tauri-apps/api/core', () => ({ invoke: mocks.invoke }))
vi.mock('../../../generated/bindings', () => ({ commands: mocks.commands }))

import { graphService } from './graph-service'

const graph: GraphDataResponse = {
  nodes: [
    {
      id: 'n1',
      type: 'note',
      label: 'Çay ☕',
      tags: ['work'],
      wordCount: 3,
      connectionCount: 1,
      emoji: null,
      color: 'var(--graph-node-note)',
      isOrphan: false,
      isUnresolved: false
    }
  ],
  edges: [{ id: 'n1-n2-wikilink', source: 'n1', target: 'n2', type: 'wikilink', weight: 1 }]
}

/** What a raw `Response` of the graph commands delivers: the JSON's UTF-8 bytes. */
function raw(value: unknown): ArrayBuffer {
  // Copied into this realm's ArrayBuffer: `TextEncoder` answers with Node's.
  const encoded = new TextEncoder().encode(JSON.stringify(value))
  const bytes = new Uint8Array(encoded.length)
  bytes.set(encoded)
  return bytes.buffer
}

describe('graph-service', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('reads the whole-vault graph from the raw command', async () => {
    mocks.invoke.mockResolvedValue(raw(graph))

    await expect(graphService.getData()).resolves.toEqual(graph)
    expect(mocks.invoke).toHaveBeenCalledWith('graph_get_graph_data', undefined)
  })

  it('reads a local graph with the depth the caller asked for, or none', async () => {
    mocks.invoke.mockResolvedValue(raw(graph))

    await expect(graphService.getLocal({ noteId: 'n1', depth: 3 })).resolves.toEqual(graph)
    await graphService.getLocal({ noteId: 'n1' })

    expect(mocks.invoke).toHaveBeenNthCalledWith(1, 'graph_get_local_graph', {
      noteId: 'n1',
      depth: 3
    })
    expect(mocks.invoke).toHaveBeenNthCalledWith(2, 'graph_get_local_graph', {
      noteId: 'n1',
      depth: null
    })
  })

  it('saves, reads and clears a view layout through the layout commands', async () => {
    const layout: GraphLayout = { version: 1, nodes: { n1: { x: 1, y: 2, pinned: true } } }
    mocks.commands.graphGetLayout.mockResolvedValue(layout)
    mocks.commands.graphSaveLayout.mockResolvedValue(null)
    mocks.commands.graphClearLayout.mockResolvedValue(null)

    await graphService.saveLayout({ viewKey: 'global', layout })
    await expect(graphService.getLayout('global')).resolves.toEqual(layout)
    await graphService.clearLayout('global')

    expect(mocks.commands.graphSaveLayout).toHaveBeenCalledWith('global', layout)
    expect(mocks.commands.graphGetLayout).toHaveBeenCalledWith('global')
    expect(mocks.commands.graphClearLayout).toHaveBeenCalledWith('global')
  })
})
