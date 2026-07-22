import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

// cmdk scrolls the highlighted item into view on selection change; jsdom has
// no layout engine, so Element.prototype.scrollIntoView doesn't exist. Same
// shim as components/tasks/quick-add-input.test.tsx.
Element.prototype.scrollIntoView = vi.fn()

const mocks = vi.hoisted(() => ({
  sources: {
    results: [] as unknown[],
    events: [] as unknown[],
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
function eventItem(id: string, title: string) {
  return { id, title, startAt: '2026-07-22T09:00:00.000Z', endAt: null, isAllDay: false }
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
  const { rerender } = render(<CanvasAddCardDialog {...props} />)
  return { ...props, rerender: () => rerender(<CanvasAddCardDialog {...props} />) }
}

describe('CanvasAddCardDialog', () => {
  beforeEach(() => {
    mocks.sources = { results: [], events: [], loading: false }
  })

  it('offers create-new-note when the query is empty', () => {
    const props = setup()
    fireEvent.click(screen.getByTestId('canvas-add-create-note'))
    expect(props.onCreateNote).toHaveBeenCalledWith('')
  })

  it('renders all three groups', async () => {
    mocks.sources = {
      results: [noteResult('n1', 'Alpha'), taskResult('t1', 'Ship it')],
      events: [eventItem('e1', 'Standup')],
      loading: false
    }
    setup()
    fireEvent.change(screen.getByTestId('canvas-add-input'), { target: { value: 'a' } })
    await waitFor(() => expect(screen.getByText('Alpha')).toBeInTheDocument())
    expect(screen.getByText('Ship it')).toBeInTheDocument()
    expect(screen.getByText('Standup')).toBeInTheDocument()
  })

  it('picks a fresh entity', async () => {
    mocks.sources = { results: [taskResult('t1', 'Ship it')], events: [], loading: false }
    const props = setup()
    fireEvent.change(screen.getByTestId('canvas-add-input'), { target: { value: 'ship' } })
    await waitFor(() => expect(screen.getByTestId('canvas-add-item-task:t1')).toBeInTheDocument())
    fireEvent.click(screen.getByTestId('canvas-add-item-task:t1'))
    expect(props.onPick).toHaveBeenCalledWith('task', 't1')
    expect(props.onReveal).not.toHaveBeenCalled()
  })

  it('reveals instead of duplicating an entity already on the canvas', async () => {
    mocks.sources = { results: [taskResult('t1', 'Ship it')], events: [], loading: false }
    const props = setup({ onCanvasKeys: new Set(['task:t1']) })
    fireEvent.change(screen.getByTestId('canvas-add-input'), { target: { value: 'ship' } })
    await waitFor(() => expect(screen.getByTestId('canvas-add-item-task:t1')).toBeInTheDocument())
    expect(screen.getByText('addOnCanvas')).toBeInTheDocument()
    fireEvent.click(screen.getByTestId('canvas-add-item-task:t1'))
    expect(props.onReveal).toHaveBeenCalledWith('task', 't1')
    expect(props.onPick).not.toHaveBeenCalled()
  })

  it('keeps the create row visible while typing and carries the query', async () => {
    mocks.sources = { results: [taskResult('t1', 'Ship it')], events: [], loading: false }
    const props = setup()
    fireEvent.change(screen.getByTestId('canvas-add-input'), { target: { value: 'groceries' } })
    await waitFor(() => expect(screen.getByTestId('canvas-add-item-task:t1')).toBeInTheDocument())
    fireEvent.click(screen.getByTestId('canvas-add-create-note'))
    expect(props.onCreateNote).toHaveBeenCalledWith('groceries')
  })

  it('hides the empty state for a blank query', () => {
    setup()
    expect(screen.queryByTestId('canvas-add-empty')).not.toBeInTheDocument()
  })

  it('shows the empty state when a non-blank query has no matches', () => {
    setup()
    fireEvent.change(screen.getByTestId('canvas-add-input'), { target: { value: 'nomatch' } })
    expect(screen.getByTestId('canvas-add-empty')).toBeInTheDocument()
  })

  it('hides the empty state once matches exist', async () => {
    mocks.sources = { results: [taskResult('t1', 'Ship it')], events: [], loading: false }
    setup()
    fireEvent.change(screen.getByTestId('canvas-add-input'), { target: { value: 'ship' } })
    await waitFor(() => expect(screen.getByTestId('canvas-add-item-task:t1')).toBeInTheDocument())
    expect(screen.queryByTestId('canvas-add-empty')).not.toBeInTheDocument()
  })

  it('keeps the create row highlighted for a blank query', () => {
    // The hook (tested separately) never returns events for a blank query, so
    // this mocks the state it actually produces — the dialog itself no longer
    // filters by query (#869).
    mocks.sources = {
      results: [],
      events: [],
      loading: false
    }
    const props = setup()
    fireEvent.keyDown(screen.getByTestId('canvas-add-input'), { key: 'Enter' })
    expect(props.onCreateNote).toHaveBeenCalledWith('')
    expect(props.onPick).not.toHaveBeenCalled()
  })

  it('suppresses the empty state while a search is in flight', () => {
    mocks.sources = { results: [], events: [], loading: true }
    setup()
    fireEvent.change(screen.getByTestId('canvas-add-input'), { target: { value: 'ship' } })
    expect(screen.queryByTestId('canvas-add-empty')).not.toBeInTheDocument()
  })

  it('lets Enter pick the first match instead of creating a note', async () => {
    const props = setup()
    // Type before results exist, matching the real debounced-search timing:
    // the query settles first, then results land in a later render. Changing
    // both on the same render races cmdk's own value reset (it re-picks the
    // first mounted item on every keystroke) against our own effect.
    fireEvent.change(screen.getByTestId('canvas-add-input'), { target: { value: 'a' } })
    mocks.sources = {
      results: [taskResult('t1', 'Ship it'), noteResult('n1', 'Alpha')],
      events: [],
      loading: false
    }
    props.rerender()
    await waitFor(() => expect(screen.getByTestId('canvas-add-item-note:n1')).toBeInTheDocument())
    fireEvent.keyDown(screen.getByTestId('canvas-add-input'), { key: 'Enter' })
    expect(props.onPick).toHaveBeenCalledWith('note', 'n1')
    expect(props.onCreateNote).not.toHaveBeenCalled()
  })
})
