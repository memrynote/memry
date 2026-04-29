import { beforeAll, describe, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
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
})
