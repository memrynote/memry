import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

// cmdk scrolls the highlighted row into view; jsdom has no layout engine.
Element.prototype.scrollIntoView = vi.fn()

const mocks = vi.hoisted(() => ({
  getAllWithCounts: vi.fn(),
  getPropertyDefinitions: vi.fn()
}))

vi.mock('@memry/i18n/renderer', () => {
  const t = (key: string, vars?: Record<string, unknown>) =>
    vars ? `${key.split('.').at(-1)}:${JSON.stringify(vars)}` : (key.split('.').at(-1) ?? key)
  const result = { t }
  return { useT: () => result }
})
vi.mock('@/services/tags-service', () => ({
  tagsService: { getAllWithCounts: mocks.getAllWithCounts }
}))
vi.mock('@/services/notes-service', () => ({
  notesService: { getPropertyDefinitions: mocks.getPropertyDefinitions }
}))

import { CanvasFrameBindingDialog } from './canvas-frame-binding-dialog'
import { CanvasFrameLayoutDialog } from './canvas-frame-layout-dialog'

const definitions = [
  {
    name: 'Status',
    type: 'status',
    options: null,
    defaultValue: null,
    color: null,
    createdAt: ''
  },
  {
    name: 'Topics',
    type: 'multiselect',
    options: JSON.stringify([{ value: 'sleep', color: 'blue' }]),
    defaultValue: null,
    color: null,
    createdAt: ''
  },
  { name: 'Empty', type: 'select', options: '[]', defaultValue: null, color: null, createdAt: '' },
  { name: 'Notes', type: 'text', options: null, defaultValue: null, color: null, createdAt: '' }
]

beforeEach(() => {
  vi.clearAllMocks()
  mocks.getAllWithCounts.mockResolvedValue({
    tags: [
      { name: 'health', count: 2 },
      { name: 'health/sleep', count: 1 }
    ]
  })
  mocks.getPropertyDefinitions.mockResolvedValue(definitions)
})

function renderBinding(props: Partial<Parameters<typeof CanvasFrameBindingDialog>[0]> = {}) {
  const all = {
    open: true,
    onOpenChange: vi.fn(),
    current: null,
    onPick: vi.fn(),
    onUnbind: vi.fn(),
    ...props
  }
  render(<CanvasFrameBindingDialog {...all} />)
  return all
}

describe('CanvasFrameBindingDialog', () => {
  it('lists tags and the values of bindable properties only', async () => {
    renderBinding()
    expect(await screen.findByTestId('canvas-frame-tag-health/sleep')).toBeInTheDocument()
    expect(screen.getByTestId('canvas-frame-prop-Status-Done')).toBeInTheDocument()
    expect(screen.getByTestId('canvas-frame-prop-Topics-sleep')).toBeInTheDocument()
    expect(screen.queryByText('Empty')).toBeNull()
    expect(screen.queryByText('Notes')).toBeNull()
  })

  it('binds a picked property value and closes', async () => {
    const props = renderBinding()
    fireEvent.click(await screen.findByTestId('canvas-frame-prop-Status-Done'))
    expect(props.onPick).toHaveBeenCalledWith({
      kind: 'property',
      property: 'Status',
      value: 'Done',
      propertyType: 'status'
    })
    expect(props.onOpenChange).toHaveBeenCalledWith(false)
  })

  it('filters by the query and offers a typed tag that does not exist yet', async () => {
    const props = renderBinding()
    await screen.findByTestId('canvas-frame-tag-health')
    fireEvent.change(screen.getByTestId('canvas-frame-binding-input'), {
      target: { value: '#Work/Q3' }
    })
    await waitFor(() => expect(screen.queryByTestId('canvas-frame-tag-health')).toBeNull())
    fireEvent.click(screen.getByTestId('canvas-frame-new-tag'))
    expect(props.onPick).toHaveBeenCalledWith({ kind: 'tag', tag: 'work/q3' })
  })

  it('does not offer an existing tag as new, and says when nothing matches', async () => {
    renderBinding()
    await screen.findByTestId('canvas-frame-tag-health')
    const input = screen.getByTestId('canvas-frame-binding-input')
    fireEvent.change(input, { target: { value: 'health' } })
    expect(screen.queryByTestId('canvas-frame-new-tag')).toBeNull()
    fireEvent.change(input, { target: { value: '!!!' } })
    expect(await screen.findByText('bindEmpty')).toBeInTheDocument()
  })

  it('marks the current binding and can remove it', async () => {
    const props = renderBinding({ current: { kind: 'tag', tag: 'health' } })
    const row = await screen.findByTestId('canvas-frame-tag-health')
    expect(row.textContent).toContain('current')
    fireEvent.click(screen.getByTestId('canvas-frame-unbind'))
    expect(props.onUnbind).toHaveBeenCalled()
    expect(props.onOpenChange).toHaveBeenCalledWith(false)
  })

  it('still lists properties when tags fail to load', async () => {
    mocks.getAllWithCounts.mockRejectedValue(new Error('nope'))
    renderBinding()
    expect(await screen.findByTestId('canvas-frame-prop-Status-Done')).toBeInTheDocument()
  })

  it('loads nothing while closed', () => {
    renderBinding({ open: false })
    expect(mocks.getAllWithCounts).not.toHaveBeenCalled()
  })
})

describe('CanvasFrameLayoutDialog', () => {
  it('lists bindable properties and picks one', async () => {
    const onPick = vi.fn()
    const onOpenChange = vi.fn()
    render(<CanvasFrameLayoutDialog open onOpenChange={onOpenChange} onPick={onPick} />)
    const row = await screen.findByTestId('canvas-frame-layout-Status')
    expect(screen.getByTestId('canvas-frame-layout-Topics')).toBeInTheDocument()
    expect(screen.queryByTestId('canvas-frame-layout-Notes')).toBeNull()
    fireEvent.click(row)
    expect(onPick).toHaveBeenCalledWith({
      name: 'Status',
      type: 'status',
      values: ['Not started', 'In Progress', 'Done', 'Abandoned']
    })
    expect(onOpenChange).toHaveBeenCalledWith(false)
  })

  it('says so when no property can lay the board out', async () => {
    mocks.getPropertyDefinitions.mockRejectedValue(new Error('nope'))
    render(<CanvasFrameLayoutDialog open onOpenChange={vi.fn()} onPick={vi.fn()} />)
    expect(await screen.findByText('layoutEmpty')).toBeInTheDocument()
  })
})
