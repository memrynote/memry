import { beforeAll, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import { I18nextProvider } from 'react-i18next'
import type { i18n as I18nInstance } from 'i18next'
import Graph from 'graphology'
import { createRendererI18n } from '@memry/i18n/renderer'
import { GraphContextMenu } from './graph-context-menu'

let i18nEn: I18nInstance

beforeAll(async () => {
  i18nEn = await createRendererI18n({ locale: 'en' })
})

function buildGraph(): Graph {
  const graph = new Graph({ multi: true, type: 'undirected' })
  const note = (label: string, tags: string[] = []): Record<string, unknown> => ({
    label,
    nodeType: 'note',
    tags,
    isUnresolved: false
  })
  graph.addNode('a', note('Alpha', ['work']))
  graph.addNode('b', note('Beta', ['ideas']))
  graph.addNode('c', note('Gamma'))
  graph.addNode('j', { label: '2026-01-01', nodeType: 'journal', tags: [], isUnresolved: false })
  graph.addNode('t', { label: 'Task', nodeType: 'task', tags: [], isUnresolved: false })
  graph.addEdgeWithKey('a-b-relation', 'a', 'b', { edgeType: 'relation' })
  graph.addEdgeWithKey('c-a-wikilink', 'c', 'a', { edgeType: 'wikilink' })
  return graph
}

function renderMenu(nodeId: string) {
  const handlers = {
    onFocusNode: vi.fn(),
    onOpenInTab: vi.fn(),
    onLinkTo: vi.fn(),
    onAddTag: vi.fn(),
    onUnlink: vi.fn(),
    onClose: vi.fn()
  }
  render(
    <I18nextProvider i18n={i18nEn}>
      <GraphContextMenu menu={{ nodeId, x: 0, y: 0 }} graph={buildGraph()} {...handlers} />
    </I18nextProvider>
  )
  return handlers
}

describe('GraphContextMenu editing', () => {
  it('links to a searched note, excluding the node itself and non-notes', () => {
    const { onLinkTo, onClose } = renderMenu('a')

    fireEvent.click(screen.getByText('Link to…'))
    const input = screen.getByLabelText('Search notes…')

    expect(screen.getByText('Beta')).toBeInTheDocument()
    expect(screen.getByText('Gamma')).toBeInTheDocument()
    expect(screen.queryByText('Alpha')).not.toBeInTheDocument()
    expect(screen.queryByText('2026-01-01')).not.toBeInTheDocument()
    expect(screen.queryByText('Task')).not.toBeInTheDocument()

    fireEvent.change(input, { target: { value: 'gam' } })
    expect(screen.queryByText('Beta')).not.toBeInTheDocument()
    fireEvent.keyDown(input, { key: 'Enter' })

    expect(onLinkTo).toHaveBeenCalledWith('a', 'c')
    expect(onClose).toHaveBeenCalled()
  })

  it('adds an existing tag or creates a new one', () => {
    const { onAddTag } = renderMenu('a')

    fireEvent.click(screen.getByText('Add tag…'))
    // The node's own tag is not offered again.
    expect(screen.queryByText('#work')).not.toBeInTheDocument()
    fireEvent.click(screen.getByText('#ideas'))
    expect(onAddTag).toHaveBeenLastCalledWith('a', 'ideas')
  })

  it('creates a typed tag in normalized form', () => {
    const { onAddTag } = renderMenu('a')

    fireEvent.click(screen.getByText('Add tag…'))
    const input = screen.getByLabelText('Search or create a tag…')
    fireEvent.change(input, { target: { value: '#Reading' } })
    expect(screen.getByText('Create #reading')).toBeInTheDocument()
    fireEvent.keyDown(input, { key: 'Enter' })

    expect(onAddTag).toHaveBeenCalledWith('a', 'reading')
  })

  it('lists relation links for removal, but not wiki links', () => {
    const { onUnlink } = renderMenu('a')

    expect(screen.queryByText('Remove link to Gamma')).not.toBeInTheDocument()
    fireEvent.click(screen.getByText('Remove link to Beta'))

    expect(onUnlink).toHaveBeenCalledWith({
      sourceId: 'a',
      targetId: 'b',
      otherId: 'b',
      otherLabel: 'Beta'
    })
  })

  it('offers incoming relation links from the target side', () => {
    const { onUnlink } = renderMenu('b')

    fireEvent.click(screen.getByText('Remove link to Alpha'))
    expect(onUnlink).toHaveBeenCalledWith(expect.objectContaining({ sourceId: 'a', targetId: 'b' }))
  })

  it('hides edit actions on nodes the graph cannot edit', () => {
    renderMenu('j')

    expect(screen.queryByText('Link to…')).not.toBeInTheDocument()
    expect(screen.queryByText('Add tag…')).not.toBeInTheDocument()
  })

  it('returns to the main menu from a picker', () => {
    renderMenu('a')

    fireEvent.click(screen.getByText('Link to…'))
    fireEvent.click(screen.getByLabelText('Back'))

    expect(screen.getByText('Focus on this node')).toBeInTheDocument()
  })
})
