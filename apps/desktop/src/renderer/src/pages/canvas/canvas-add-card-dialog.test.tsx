import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

// cmdk scrolls the highlighted item into view on selection change; jsdom has
// no layout engine, so Element.prototype.scrollIntoView doesn't exist. Same
// shim as components/tasks/quick-add-input.test.tsx.
Element.prototype.scrollIntoView = vi.fn()

const mocks = vi.hoisted(() => ({
  sources: {
    results: [] as unknown[],
    projections: [] as unknown[],
    loading: false
  }
}))

vi.mock('@memry/i18n/renderer', () => ({
  useT: () => ({
    t: (key: string, vars?: Record<string, unknown>) =>
      vars?.query
        ? `${key.split('.').at(-1)}:${String(vars.query)}`
        : (key.split('.').at(-1) ?? key)
  })
}))
vi.mock('./use-canvas-add-search', () => ({
  useCanvasAddSearch: () => mocks.sources
}))

import { CanvasAddCardDialog } from './canvas-add-card-dialog'

function noteResult(id: string, title: string) {
  return { id, type: 'note', title, metadata: { type: 'note', path: `n/${title}.md`, tags: [] } }
}
function taskResult(id: string, title: string) {
  return { id, type: 'task', title, metadata: { type: 'task', projectName: 'Inbox' } }
}
function eventProjection(sourceId: string, title: string) {
  return {
    projectionId: `${sourceId}-1`,
    sourceType: 'event',
    sourceId,
    title,
    startAt: '2026-07-22T09:00:00.000Z'
  }
}

function setup(overrides: Partial<Parameters<typeof CanvasAddCardDialog>[0]> = {}) {
  const props = {
    open: true,
    onOpenChange: vi.fn(),
    onCanvasKeys: new Set<string>(),
    onCreateNote: vi.fn(),
    onPick: vi.fn(),
    onReveal: vi.fn(),
    ...overrides
  }
  render(<CanvasAddCardDialog {...props} />)
  return props
}

describe('CanvasAddCardDialog', () => {
  beforeEach(() => {
    mocks.sources = { results: [], projections: [], loading: false }
  })

  it('offers create-new-note when the query is empty', () => {
    const props = setup()
    fireEvent.click(screen.getByTestId('canvas-add-create-note'))
    expect(props.onCreateNote).toHaveBeenCalledWith('')
  })

  it('renders all three groups', async () => {
    mocks.sources = {
      results: [noteResult('n1', 'Alpha'), taskResult('t1', 'Ship it')],
      projections: [eventProjection('e1', 'Standup')],
      loading: false
    }
    setup()
    fireEvent.change(screen.getByTestId('canvas-add-input'), { target: { value: 'a' } })
    await waitFor(() => expect(screen.getByText('Alpha')).toBeInTheDocument())
    expect(screen.getByText('Ship it')).toBeInTheDocument()
    expect(screen.getByText('Standup')).toBeInTheDocument()
  })

  it('picks a fresh entity', async () => {
    mocks.sources = { results: [taskResult('t1', 'Ship it')], projections: [], loading: false }
    const props = setup()
    fireEvent.change(screen.getByTestId('canvas-add-input'), { target: { value: 'ship' } })
    await waitFor(() => expect(screen.getByTestId('canvas-add-item-task:t1')).toBeInTheDocument())
    fireEvent.click(screen.getByTestId('canvas-add-item-task:t1'))
    expect(props.onPick).toHaveBeenCalledWith('task', 't1')
    expect(props.onReveal).not.toHaveBeenCalled()
  })

  it('reveals instead of duplicating an entity already on the canvas', async () => {
    mocks.sources = { results: [taskResult('t1', 'Ship it')], projections: [], loading: false }
    const props = setup({ onCanvasKeys: new Set(['task:t1']) })
    fireEvent.change(screen.getByTestId('canvas-add-input'), { target: { value: 'ship' } })
    await waitFor(() => expect(screen.getByTestId('canvas-add-item-task:t1')).toBeInTheDocument())
    expect(screen.getByText('addOnCanvas')).toBeInTheDocument()
    fireEvent.click(screen.getByTestId('canvas-add-item-task:t1'))
    expect(props.onReveal).toHaveBeenCalledWith('task', 't1')
    expect(props.onPick).not.toHaveBeenCalled()
  })

  it('keeps the create row visible while typing and carries the query', async () => {
    mocks.sources = { results: [taskResult('t1', 'Ship it')], projections: [], loading: false }
    const props = setup()
    fireEvent.change(screen.getByTestId('canvas-add-input'), { target: { value: 'groceries' } })
    await waitFor(() => expect(screen.getByTestId('canvas-add-item-task:t1')).toBeInTheDocument())
    fireEvent.click(screen.getByTestId('canvas-add-create-note'))
    expect(props.onCreateNote).toHaveBeenCalledWith('groceries')
  })
})
