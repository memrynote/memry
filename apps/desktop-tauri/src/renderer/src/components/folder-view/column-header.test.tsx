import { fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { ColumnHeader } from './column-header'
import { SortableColumnHeader } from './sortable-column-header'

const mocks = vi.hoisted(() => ({
  sortable: {
    attributes: { role: 'button' },
    listeners: { onPointerDown: vi.fn() },
    setNodeRef: vi.fn(),
    transition: 'opacity 100ms',
    isDragging: false,
    isOver: false
  }
}))

vi.mock('@memry/i18n/renderer', () => ({
  // Echo the key, plus any interpolation params, so assertions can pin both the
  // key and the values passed into it.
  useT: () => ({
    t: (key: string, params?: Record<string, unknown>) =>
      params
        ? `${key}(${Object.entries(params)
            .map(([name, value]) => `${name}=${String(value)}`)
            .join(', ')})`
        : key
  })
}))

vi.mock('@dnd-kit/sortable', () => ({
  useSortable: () => mocks.sortable
}))

function createHeader(overrides: Partial<Record<string, unknown>> = {}) {
  const column = {
    id: (overrides.columnId as string | undefined) ?? 'createdAt',
    getIsSorted: vi.fn(() => false),
    getCanSort: vi.fn(() => true),
    toggleSorting: vi.fn(),
    getSize: vi.fn(() => 120),
    getIsResizing: vi.fn(() => false)
  }
  return {
    column,
    getSize: vi.fn(() => 120),
    getResizeHandler: vi.fn(() => vi.fn()),
    ...Object.fromEntries(Object.entries(overrides).filter(([key]) => key !== 'columnId'))
  } as any
}

describe('ColumnHeader components', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.sortable.isDragging = false
    mocks.sortable.isOver = false
  })

  it('sorts, edits display names, cancels edits, and emits changed widths', () => {
    const header = createHeader()
    const onDisplayNameChange = vi.fn()
    const onWidthChange = vi.fn()

    render(
      <table>
        <thead>
          <tr>
            <ColumnHeader
              header={header}
              columnConfig={{ id: 'createdAt', type: 'created' } as any}
              onDisplayNameChange={onDisplayNameChange}
              onWidthChange={onWidthChange}
              dragHandleProps={{ attributes: { 'aria-label': 'drag' }, listeners: {} }}
            />
          </tr>
        </thead>
      </table>
    )

    fireEvent.click(screen.getByText('Created At'))
    expect(header.column.toggleSorting).toHaveBeenCalledWith(undefined, true)

    fireEvent.doubleClick(screen.getByText('Created At'))
    const input = screen.getByDisplayValue('Created At')
    fireEvent.change(input, { target: { value: 'Created' } })
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(onDisplayNameChange).toHaveBeenCalledWith('createdAt', 'Created')

    fireEvent.doubleClick(screen.getByText('Created At'))
    fireEvent.keyDown(screen.getByDisplayValue('Created At'), { key: 'Escape' })
    expect(screen.queryByDisplayValue('Created At')).not.toBeInTheDocument()

    header.column.getSize.mockReturnValueOnce(120).mockReturnValue(160)
    fireEvent.mouseDown(screen.getByText('Created At').closest('th')!.querySelector('.w-1')!)
    fireEvent.mouseUp(document)
    expect(onWidthChange).toHaveBeenCalledWith('createdAt', 160)
  })

  it('renders sorted and disabled column-header variants without firing sort', () => {
    const sortedHeader = createHeader()
    sortedHeader.column.getIsSorted.mockReturnValue('desc')
    const disabledHeader = createHeader()
    disabledHeader.column.getCanSort.mockReturnValue(false)

    const { rerender } = render(
      <table>
        <thead>
          <tr>
            <ColumnHeader
              header={sortedHeader}
              columnConfig={{ id: 'title', displayName: 'Title', type: 'title' } as any}
              sortIndex={2}
              totalSortedColumns={3}
              isHighlighted
              isDragging
            />
          </tr>
        </thead>
      </table>
    )
    expect(screen.getByText('▼')).toBeInTheDocument()
    expect(screen.getByText('2')).toBeInTheDocument()

    rerender(
      <table>
        <thead>
          <tr>
            <ColumnHeader
              header={disabledHeader}
              columnConfig={{ id: 'title', displayName: 'Title', type: 'title' } as any}
            />
          </tr>
        </thead>
      </table>
    )
    fireEvent.click(screen.getByText('Title'))
    expect(disabledHeader.column.toggleSorting).not.toHaveBeenCalled()
  })

  it('covers sortable drag, resize keyboard, density, icon, and drop indicator states', () => {
    const header = createHeader({ columnId: 'status' })
    const onDisplayNameChange = vi.fn()
    const onWidthChange = vi.fn()
    const Icon = ({ className }: { className?: string }) => (
      <span data-testid="column-icon" className={className} />
    )
    mocks.sortable.isOver = true
    mocks.sortable.isDragging = true

    render(
      <table>
        <thead>
          <tr>
            <SortableColumnHeader
              header={header}
              columnConfig={{ id: 'status', displayName: 'Status', type: 'property' } as any}
              icon={Icon}
              onDisplayNameChange={onDisplayNameChange}
              onWidthChange={onWidthChange}
              sortIndex={1}
              totalSortedColumns={2}
              density="compact"
              showColumnBorders
              isLastColumn
              isHighlighted
            />
          </tr>
        </thead>
      </table>
    )

    expect(mocks.sortable.setNodeRef).toHaveBeenCalled()
    expect(screen.getByTestId('column-icon')).toBeInTheDocument()

    fireEvent.click(screen.getByText('Status'))
    expect(header.column.toggleSorting).toHaveBeenCalledWith(undefined, true)

    const resizeHandle = screen.getByRole('separator')
    fireEvent.keyDown(resizeHandle, { key: 'ArrowRight' })
    fireEvent.keyDown(resizeHandle, { key: 'ArrowLeft' })
    expect(onWidthChange).toHaveBeenNthCalledWith(1, 'status', 130)
    expect(onWidthChange).toHaveBeenNthCalledWith(2, 'status', 110)

    fireEvent.doubleClick(screen.getByText('Status'))
    const input = screen.getByDisplayValue('Status')
    fireEvent.change(input, { target: { value: 'Stage' } })
    fireEvent.blur(input)
    expect(onDisplayNameChange).toHaveBeenCalledWith('status', 'Stage')
  })

  it('covers sortable header edit, resize, sort, and drag-handle edge branches', () => {
    const header = createHeader({ columnId: 'customName' })
    const onDisplayNameChange = vi.fn()
    const onWidthChange = vi.fn()

    render(
      <table>
        <thead>
          <tr>
            <SortableColumnHeader
              header={header}
              columnConfig={{ id: 'customName', type: 'property' } as any}
              onDisplayNameChange={onDisplayNameChange}
              onWidthChange={onWidthChange}
            />
          </tr>
        </thead>
      </table>
    )

    fireEvent.click(screen.getByText('Custom Name'))
    expect(header.column.toggleSorting).toHaveBeenCalledWith(undefined, true)

    fireEvent.doubleClick(screen.getByText('Custom Name'))
    fireEvent.click(screen.getByDisplayValue('Custom Name'))
    expect(header.column.toggleSorting).toHaveBeenCalledTimes(1)

    const blankInput = screen.getByDisplayValue('Custom Name')
    fireEvent.change(blankInput, { target: { value: '   ' } })
    fireEvent.keyDown(blankInput, { key: 'Enter' })
    expect(onDisplayNameChange).not.toHaveBeenCalled()

    fireEvent.doubleClick(screen.getByText('Custom Name'))
    fireEvent.change(screen.getByDisplayValue('Custom Name'), { target: { value: 'Custom Name' } })
    fireEvent.blur(screen.getByDisplayValue('Custom Name'))
    expect(onDisplayNameChange).not.toHaveBeenCalled()

    fireEvent.doubleClick(screen.getByText('Custom Name'))
    fireEvent.keyDown(screen.getByDisplayValue('Custom Name'), { key: 'Escape' })
    expect(screen.queryByDisplayValue('Custom Name')).not.toBeInTheDocument()

    // The drag handle announces the same resolved display name the visible label
    // shows ("Custom Name"), not the raw column id.
    const dragHandle = screen.getByLabelText(
      'folderView.columnHeader.dragToReorder(name=Custom Name)'
    )
    fireEvent.click(dragHandle)
    fireEvent.keyDown(dragHandle, { key: 'Enter' })
    fireEvent.keyDown(dragHandle, { key: ' ' })

    header.column.getSize.mockReturnValue(120)
    fireEvent.mouseDown(screen.getByRole('separator'))
    fireEvent.mouseUp(document)
    expect(onWidthChange).not.toHaveBeenCalled()
  })

  it('renders sorted sortable headers and disabled sort states', () => {
    const sortedHeader = createHeader({ columnId: '' })
    sortedHeader.column.getIsSorted.mockReturnValue('asc')
    const disabledHeader = createHeader({ columnId: 'plain' })
    disabledHeader.column.getCanSort.mockReturnValue(false)

    const { rerender } = render(
      <table>
        <thead>
          <tr>
            <SortableColumnHeader
              header={sortedHeader}
              columnConfig={{ id: '', type: 'property' } as any}
              sortIndex={1}
              totalSortedColumns={2}
            />
          </tr>
        </thead>
      </table>
    )

    expect(screen.getByText('▲')).toBeInTheDocument()
    expect(screen.getByText('1')).toBeInTheDocument()

    rerender(
      <table>
        <thead>
          <tr>
            <SortableColumnHeader
              header={disabledHeader}
              columnConfig={{ id: 'plain', displayName: 'Plain', type: 'property' } as any}
            />
          </tr>
        </thead>
      </table>
    )

    fireEvent.click(screen.getByText('Plain'))
    expect(disabledHeader.column.toggleSorting).not.toHaveBeenCalled()
  })
})
