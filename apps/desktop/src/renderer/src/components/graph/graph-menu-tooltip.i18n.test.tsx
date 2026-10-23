import { beforeAll, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import { I18nextProvider } from 'react-i18next'
import type { i18n as I18nInstance } from 'i18next'
import Graph from 'graphology'
import { createRendererI18n } from '@memry/i18n/renderer'
import { GraphContextMenu } from './graph-context-menu'
import { GraphTooltip } from './graph-tooltip'

let i18nEn: I18nInstance

beforeAll(async () => {
  i18nEn = await createRendererI18n({ locale: 'en' })
})

function renderWithI18n(ui: React.ReactElement): void {
  render(<I18nextProvider i18n={i18nEn}>{ui}</I18nextProvider>)
}

describe('graph menu and tooltip i18n', () => {
  it('renders context menu copy for existing and unresolved nodes', () => {
    const graph = new Graph()
    graph.addNode('note-1', { label: 'Alpha', isUnresolved: false })
    graph.addNode('missing-1', { label: '', isUnresolved: true })

    const props = {
      graph,
      onFocusNode: vi.fn(),
      onOpenInTab: vi.fn(),
      onCreateNote: vi.fn(),
      onClose: vi.fn()
    }

    const { rerender } = render(
      <I18nextProvider i18n={i18nEn}>
        <GraphContextMenu menu={{ nodeId: 'note-1', x: 0, y: 0 }} {...props} />
      </I18nextProvider>
    )

    expect(screen.getByText('Focus on this node')).toBeInTheDocument()
    expect(screen.getByText('Open in new tab')).toBeInTheDocument()
    expect(screen.getByText('Copy title')).toBeInTheDocument()

    rerender(
      <I18nextProvider i18n={i18nEn}>
        <GraphContextMenu menu={{ nodeId: 'missing-1', x: 0, y: 0 }} {...props} />
      </I18nextProvider>
    )

    expect(screen.getByText('Untitled')).toBeInTheDocument()
    expect(screen.getByText('Create note')).toBeInTheDocument()
  })

  it('offers Unpin only on a pinned node', () => {
    const graph = new Graph()
    graph.addNode('note-1', { label: 'Alpha', isUnresolved: false })
    graph.addNode('note-2', { label: 'Beta', isUnresolved: false, pinned: true })
    const onUnpin = vi.fn()
    const onClose = vi.fn()
    const props = { graph, onFocusNode: vi.fn(), onOpenInTab: vi.fn(), onUnpin, onClose }

    const { rerender } = render(
      <I18nextProvider i18n={i18nEn}>
        <GraphContextMenu menu={{ nodeId: 'note-1', x: 0, y: 0 }} {...props} />
      </I18nextProvider>
    )
    expect(screen.queryByText('Unpin')).not.toBeInTheDocument()

    rerender(
      <I18nextProvider i18n={i18nEn}>
        <GraphContextMenu menu={{ nodeId: 'note-2', x: 0, y: 0 }} {...props} />
      </I18nextProvider>
    )
    fireEvent.click(screen.getByText('Unpin'))

    expect(onUnpin).toHaveBeenCalledWith('note-2')
    expect(onClose).toHaveBeenCalled()
  })

  it('renders tooltip entity and connection copy', () => {
    const graph = new Graph()
    graph.addNode('missing-1', {
      label: 'Missing note',
      nodeType: 'note',
      tags: [],
      connectionCount: 2,
      emoji: null,
      isUnresolved: true
    })

    renderWithI18n(<GraphTooltip nodeId="missing-1" graph={graph} x={0} y={0} />)

    expect(screen.getByText('unresolved')).toBeInTheDocument()
    expect(screen.getByText('2 connections')).toBeInTheDocument()
  })

  it('offers expand on a collapsed category and collapse on a member', () => {
    const graph = new Graph()
    graph.addNode('group:work', { label: 'Work (3)', nodeType: 'group', isUnresolved: false })
    graph.addNode('note-1', { label: 'Alpha', nodeType: 'note', isUnresolved: false })
    const onToggleCategory = vi.fn()
    const onClose = vi.fn()
    const props = {
      graph,
      onFocusNode: vi.fn(),
      onOpenInTab: vi.fn(),
      onToggleCategory,
      onClose
    }

    const { rerender } = render(
      <I18nextProvider i18n={i18nEn}>
        <GraphContextMenu
          menu={{ nodeId: 'group:work', x: 0, y: 0 }}
          categoryAction={{ categoryId: 'work', label: 'Work', collapsed: true }}
          {...props}
        />
      </I18nextProvider>
    )

    // A super-node is not a note: no open or copy actions.
    expect(screen.queryByText('Open in new tab')).not.toBeInTheDocument()
    expect(screen.queryByText('Copy title')).not.toBeInTheDocument()
    fireEvent.click(screen.getByText('Expand Work'))
    expect(onToggleCategory).toHaveBeenCalledWith('work')
    expect(onClose).toHaveBeenCalledOnce()

    rerender(
      <I18nextProvider i18n={i18nEn}>
        <GraphContextMenu
          menu={{ nodeId: 'note-1', x: 0, y: 0 }}
          categoryAction={{ categoryId: 'work', label: 'Work', collapsed: false }}
          {...props}
        />
      </I18nextProvider>
    )
    fireEvent.click(screen.getByText('Collapse Work'))
    expect(onToggleCategory).toHaveBeenLastCalledWith('work')
  })

  it('renders a collapsed category tooltip', () => {
    const graph = new Graph()
    graph.addNode('group:work', {
      label: 'Work (3)',
      nodeType: 'group',
      tags: [],
      memberCount: 3,
      connectionCount: 1,
      emoji: null,
      isUnresolved: false
    })

    renderWithI18n(<GraphTooltip nodeId="group:work" graph={graph} x={0} y={0} />)

    expect(screen.getByText('category')).toBeInTheDocument()
    expect(screen.getByText('3 items')).toBeInTheDocument()
    expect(screen.getByText('Click to expand')).toBeInTheDocument()
  })
})
