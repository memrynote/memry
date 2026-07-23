import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { FolderTableView } from './folder-table-view'
import { GroupedTable } from './grouped-table'

vi.mock('@memry/i18n/renderer', () => ({
  useT: () => ({ t: (key: string) => key.split('.').at(-1) ?? key })
}))

vi.mock('@tanstack/react-virtual', () => ({
  useVirtualizer: ({ count }: { count: number }) => ({
    getVirtualItems: () =>
      Array.from({ length: count }, (_, index) => ({
        index,
        key: index,
        start: index * 40,
        size: 40
      })),
    getTotalSize: () => count * 40,
    measureElement: vi.fn(),
    scrollToIndex: vi.fn()
  })
}))

vi.mock('@dnd-kit/core', () => ({
  DndContext: ({ children, onDragEnd }: { children: React.ReactNode; onDragEnd: any }) => (
    <div>
      {children}
      <button
        type="button"
        onClick={() => onDragEnd({ active: { id: 'title' }, over: { id: 'score' } })}
      >
        mock drag
      </button>
      <button
        type="button"
        onClick={() => onDragEnd({ active: { id: 'title' }, over: { id: 'title' } })}
      >
        mock drag same
      </button>
      <button type="button" onClick={() => onDragEnd({ active: { id: 'missing' }, over: null })}>
        mock drag none
      </button>
      <button
        type="button"
        onClick={() => onDragEnd({ active: { id: 'missing' }, over: { id: 'score' } })}
      >
        mock drag invalid
      </button>
    </div>
  ),
  closestCenter: vi.fn(),
  KeyboardSensor: vi.fn(),
  PointerSensor: vi.fn(),
  useSensor: vi.fn(() => ({})),
  useSensors: vi.fn(() => [])
}))

vi.mock('@dnd-kit/sortable', () => ({
  SortableContext: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  arrayMove: <T,>(items: T[], from: number, to: number) => {
    const next = [...items]
    const [item] = next.splice(from, 1)
    next.splice(to, 0, item)
    return next
  },
  horizontalListSortingStrategy: vi.fn(),
  sortableKeyboardCoordinates: vi.fn()
}))

vi.mock('@dnd-kit/modifiers', () => ({
  restrictToHorizontalAxis: vi.fn()
}))

vi.mock('./sortable-column-header', () => ({
  SortableColumnHeader: ({ header, columnConfig, onWidthChange, onDisplayNameChange }: any) => (
    <th style={{ width: header.getSize() }}>
      <button type="button" onClick={() => header.column.toggleSorting(false)}>
        {String(header.column.columnDef.header)}
      </button>
      <button type="button" onClick={() => onWidthChange(columnConfig.id, 220)}>
        resize {columnConfig.id}
      </button>
      <button type="button" onClick={() => onDisplayNameChange?.(columnConfig.id, 'Renamed')}>
        rename {columnConfig.id}
      </button>
    </th>
  )
}))

vi.mock('./row-context-menu', () => ({
  RowContextMenu: ({ children }: { children: React.ReactNode }) => <>{children}</>
}))

vi.mock('./folder-view-empty-state', () => ({
  FolderViewEmptyState: ({ variant, onCreateNote, onClearAll }: any) => (
    <div>
      <span>{variant}</span>
      {onCreateNote && (
        <button type="button" onClick={onCreateNote}>
          create empty
        </button>
      )}
      {onClearAll && (
        <button type="button" onClick={onClearAll}>
          clear empty
        </button>
      )}
    </div>
  )
}))

vi.mock('./summary-row', () => ({
  SummaryRow: ({ notes }: { notes: unknown[] }) => (
    <tfoot>
      <tr>
        <td>summary {notes.length}</td>
      </tr>
    </tfoot>
  )
}))

const notes = [
  {
    id: 'note-1',
    title: 'Alpha plan',
    emoji: '*',
    folder: 'Work',
    tags: ['work', 'alpha'],
    created: '2026-01-01T00:00:00.000Z',
    modified: '2026-01-02T00:00:00.000Z',
    wordCount: 100,
    properties: { score: 3, status: 'Open' }
  },
  {
    id: 'note-2',
    title: 'Beta brief',
    emoji: null,
    folder: 'Home',
    tags: ['home'],
    created: '2026-01-03T00:00:00.000Z',
    modified: '2026-01-04T00:00:00.000Z',
    wordCount: 200,
    properties: { score: 7, status: 'Done' }
  }
] as any[]

const columns = [
  { id: 'title', displayName: 'Title', width: 220 },
  { id: 'folder', displayName: 'Folder', width: 120 },
  { id: 'tags', displayName: 'Tags', width: 150 },
  { id: 'score', displayName: 'Score', width: 100 },
  { id: 'formula.double', displayName: 'Double', width: 100 },
  { id: 'missingFormula', displayName: 'Missing', width: 100 }
] as any[]

describe('FolderTableView', () => {
  it('renders rows, cells, sorting, column changes, selection, keyboard actions, and summaries', () => {
    const onNoteOpen = vi.fn()
    const onOpenInNewTab = vi.fn()
    const onFolderClick = vi.fn()
    const onTagClick = vi.fn()
    const onTagRemove = vi.fn()
    const onPropertyUpdate = vi.fn()
    const onColumnsChange = vi.fn()
    const onDisplayNameChange = vi.fn()
    const onSortingChange = vi.fn()
    const onSelectionChange = vi.fn()
    const onMoveToFolder = vi.fn()

    render(
      <FolderTableView
        notes={notes}
        columns={columns}
        formulas={{ double: 'score * 2' }}
        propertyTypes={{ score: 'number' }}
        initialSorting={[{ property: 'modified', direction: 'desc' }]}
        highlightQuery="plan"
        onNoteOpen={onNoteOpen}
        onOpenInNewTab={onOpenInNewTab}
        onFolderClick={onFolderClick}
        onTagClick={onTagClick}
        onTagRemove={onTagRemove}
        onPropertyUpdate={onPropertyUpdate}
        onColumnsChange={onColumnsChange}
        onDisplayNameChange={onDisplayNameChange}
        onSortingChange={onSortingChange}
        onSelectionChange={onSelectionChange}
        onMoveToFolder={onMoveToFolder}
        showSummaries
        summaries={{ score: { type: 'sum' } as any }}
      />
    )

    fireEvent.click(screen.getByRole('button', { name: /Alpha plan/ }))
    expect(onNoteOpen).toHaveBeenCalledWith('note-1')

    fireEvent.click(screen.getByRole('button', { name: 'Work' }))
    expect(onFolderClick).toHaveBeenCalledWith('Work')

    fireEvent.click(screen.getByRole('option', { name: 'work' }))
    expect(onTagClick).toHaveBeenCalledWith('work')

    const alphaTag = screen.getByRole('option', { name: 'alpha' })
    fireEvent.mouseEnter(alphaTag)
    fireEvent.click(screen.getByRole('button', { name: 'removeAria' }))
    expect(onTagRemove).toHaveBeenCalledWith('note-1', 'alpha')

    fireEvent.click(screen.getByRole('button', { name: 'Title' }))
    expect(onSortingChange).toHaveBeenCalledWith([{ property: 'title', direction: 'asc' }])

    fireEvent.click(screen.getByRole('button', { name: 'resize title' }))
    expect(onColumnsChange).toHaveBeenCalledWith([
      expect.objectContaining({ id: 'title', width: 220 }),
      ...columns.slice(1)
    ])

    fireEvent.click(screen.getByRole('button', { name: 'rename score' }))
    expect(onDisplayNameChange).toHaveBeenCalledWith('score', 'Renamed')

    fireEvent.click(screen.getByRole('button', { name: 'mock drag' }))
    expect(onColumnsChange).toHaveBeenCalledWith([
      columns[1],
      columns[2],
      columns[3],
      columns[0],
      columns[4],
      columns[5]
    ])

    const grid = screen.getByRole('grid', { name: 'notesTable' })
    const firstRow = grid.querySelector('[data-row-id="note-1"]')
    expect(firstRow).not.toBeNull()
    fireEvent.click(firstRow as HTMLElement)
    expect(onSelectionChange).toHaveBeenLastCalledWith(new Set(['note-1']))

    fireEvent.keyDown(grid, { key: 'ArrowDown' })
    expect(onSelectionChange).toHaveBeenLastCalledWith(new Set(['note-2']))

    fireEvent.click(firstRow as HTMLElement, { shiftKey: true })
    expect(onSelectionChange).toHaveBeenLastCalledWith(new Set(['note-1', 'note-2']))

    fireEvent.keyDown(grid, { key: 'a', metaKey: true })
    expect(onSelectionChange).toHaveBeenLastCalledWith(new Set(['note-1', 'note-2']))

    fireEvent.keyDown(grid, { key: 'm', metaKey: true, shiftKey: true })
    expect(onMoveToFolder).toHaveBeenCalledWith(['note-1', 'note-2'])

    fireEvent.keyDown(grid, { key: 'Enter' })
    expect(onNoteOpen).toHaveBeenCalledWith('note-1')

    expect(screen.getByText('summary 2')).toBeInTheDocument()
  })

  it('drives selection from the select-all header and per-row checkboxes', () => {
    const onSelectionChange = vi.fn()
    render(
      <FolderTableView notes={notes} columns={columns} onSelectionChange={onSelectionChange} />
    )

    const selectAll = screen.getByRole('checkbox', { name: 'selectAll' })
    fireEvent.click(selectAll)
    expect(onSelectionChange).toHaveBeenLastCalledWith(new Set(['note-1', 'note-2']))

    // Clicking again while fully checked clears the selection.
    fireEvent.click(selectAll)
    expect(onSelectionChange).toHaveBeenLastCalledWith(new Set())

    const rowBoxes = screen.getAllByRole('checkbox', { name: 'selectRow' })
    expect(rowBoxes).toHaveLength(2)
    fireEvent.click(rowBoxes[1])
    expect(onSelectionChange).toHaveBeenLastCalledWith(new Set(['note-2']))
    fireEvent.click(rowBoxes[1])
    expect(onSelectionChange).toHaveBeenLastCalledWith(new Set())
  })

  it('renders loading, empty, and no-results states', () => {
    const onCreateNote = vi.fn()
    const onClearAll = vi.fn()
    const { rerender } = render(<FolderTableView notes={notes} columns={columns} isLoading />)
    expect(screen.getByText('loading')).toBeInTheDocument()

    rerender(<FolderTableView notes={[]} columns={columns} onCreateNote={onCreateNote} />)
    fireEvent.click(screen.getByRole('button', { name: 'create empty' }))
    expect(onCreateNote).toHaveBeenCalled()

    rerender(
      <FolderTableView
        notes={notes}
        columns={columns}
        globalFilter="missing"
        onClearAll={onClearAll}
      />
    )
    fireEvent.click(screen.getByRole('button', { name: 'clear empty' }))
    expect(onClearAll).toHaveBeenCalled()
  })

  it('covers built-in columns, formula result variants, drag no-ops, and selection edges', () => {
    const onNoteOpen = vi.fn()
    const onColumnsChange = vi.fn()
    const onSelectionChange = vi.fn()
    const branchNotes = [
      {
        ...notes[0],
        created: null,
        modified: '',
        wordCount: 'many',
        properties: { score: 3, status: 'Open', customDate: '2026-02-03T00:00:00.000Z' }
      },
      {
        ...notes[1],
        folder: '/',
        tags: ['review', 'later'],
        properties: { score: 7, status: 'Done', customDate: '2026-02-04T00:00:00.000Z' }
      }
    ] as any[]
    const branchColumns = [
      { id: 'title' },
      { id: 'folder' },
      { id: 'tags' },
      { id: 'created' },
      { id: 'modified' },
      { id: 'wordCount' },
      { id: 'customDate' },
      { id: 'formula.date', displayName: 'Date Formula' },
      { id: 'formula.tags', displayName: 'Tags Formula' },
      { id: 'formula.empty', displayName: 'Empty Formula' },
      { id: 'formula.bool', displayName: 'Bool Formula' }
    ] as any[]

    render(
      <FolderTableView
        notes={branchNotes}
        columns={branchColumns}
        formulas={{
          date: 'dateAdd("2026-01-14", 1, "days")',
          tags: 'tags',
          empty: 'null',
          bool: 'score > 5'
        }}
        propertyTypes={{ customDate: 'date' }}
        initialSorting={[
          { property: 'folder', direction: 'asc' },
          { property: 'hiddenScore', direction: 'desc' }
        ]}
        selectedRowIds={new Set(['note-1'])}
        onNoteOpen={onNoteOpen}
        onColumnsChange={onColumnsChange}
        onSelectionChange={onSelectionChange}
        exitingRowIds={new Set(['note-2'])}
        density="compact"
        showColumnBorders={false}
        highlightedColumns={['customDate']}
      />
    )

    expect(screen.getByRole('button', { name: /Alpha plan/ })).toBeInTheDocument()
    expect(screen.getByText('Date Formula')).toBeInTheDocument()
    expect(screen.getAllByText('—').length).toBeGreaterThan(0)

    fireEvent.click(screen.getByRole('button', { name: 'mock drag same' }))
    fireEvent.click(screen.getByRole('button', { name: 'mock drag none' }))
    fireEvent.click(screen.getByRole('button', { name: 'mock drag invalid' }))
    expect(onColumnsChange).not.toHaveBeenCalled()

    const grid = screen.getByRole('grid', { name: 'notesTable' })
    const firstRow = grid.querySelector('[data-row-id="note-1"]') as HTMLElement
    const secondRow = grid.querySelector('[data-row-id="note-2"]') as HTMLElement

    fireEvent.doubleClick(secondRow)
    expect(onNoteOpen).toHaveBeenCalledWith('note-2')

    fireEvent.click(firstRow, { ctrlKey: true })
    expect(onSelectionChange).toHaveBeenLastCalledWith(new Set())

    fireEvent.click(secondRow, { ctrlKey: true })
    expect(onSelectionChange).toHaveBeenLastCalledWith(new Set(['note-1', 'note-2']))

    fireEvent.keyDown(grid, { key: 'ArrowUp', shiftKey: true })
    expect(onSelectionChange).toHaveBeenLastCalledWith(new Set(['note-1', 'note-2']))

    fireEvent.keyDown(grid, { key: ' ', code: 'Space' })
    expect(onSelectionChange).toHaveBeenLastCalledWith(new Set(['note-1']))

    fireEvent.keyDown(grid, { key: 'Escape' })
    expect(onSelectionChange).toHaveBeenLastCalledWith(new Set())

    fireEvent.keyDown(grid, { key: 'Enter' })
    expect(onNoteOpen).toHaveBeenCalledWith('note-2')
  })

  it('filters array property values and handles keyboard wrap edges without optional callbacks', () => {
    const originalUserAgent = navigator.userAgent
    Object.defineProperty(navigator, 'userAgent', {
      configurable: true,
      value: 'Firefox'
    })

    const onNoteOpen = vi.fn()
    const onSelectionChange = vi.fn()
    const arrayNotes = [
      {
        ...notes[0],
        properties: { ...notes[0].properties, keywords: ['review', 'plan'] }
      },
      {
        ...notes[1],
        properties: { ...notes[1].properties, keywords: ['archive'] }
      }
    ] as any[]
    const arrayColumns = [
      { id: 'title', displayName: 'Title', width: 200 },
      { id: 'keywords', displayName: 'Keywords', width: 120 }
    ] as any[]

    render(
      <FolderTableView
        notes={arrayNotes}
        columns={arrayColumns}
        propertyTypes={{ keywords: 'multiselect' }}
        initialSorting={[
          { property: 'folder', direction: 'asc' },
          { property: 'tags', direction: 'asc' },
          { property: 'created', direction: 'asc' },
          { property: 'modified', direction: 'desc' },
          { property: 'wordCount', direction: 'desc' },
          { property: 'missingProperty', direction: 'asc' }
        ]}
        onNoteOpen={onNoteOpen}
        onSelectionChange={onSelectionChange}
      />
    )

    expect(screen.getByRole('button', { name: /Alpha plan/ })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /Beta brief/ })).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'resize title' }))

    const grid = screen.getByRole('grid', { name: 'notesTable' })
    fireEvent.keyDown(grid, { key: 'ArrowDown' })
    expect(onSelectionChange).toHaveBeenLastCalledWith(new Set(['note-2']))
    fireEvent.keyDown(grid, { key: 'ArrowDown' })
    expect(onSelectionChange).toHaveBeenLastCalledWith(new Set(['note-1']))
    fireEvent.keyDown(grid, { key: 'ArrowDown', shiftKey: true })
    expect(onSelectionChange).toHaveBeenLastCalledWith(new Set(['note-1']))
    fireEvent.keyDown(grid, { key: 'ArrowUp' })
    expect(onSelectionChange).toHaveBeenLastCalledWith(new Set(['note-2']))
    fireEvent.keyDown(grid, { key: 'ArrowUp', shiftKey: true })
    expect(onSelectionChange).toHaveBeenLastCalledWith(new Set(['note-2']))
    fireEvent.keyDown(grid, { key: ' ', code: 'Space' })
    expect(onSelectionChange).toHaveBeenLastCalledWith(new Set(['note-1']))
    fireEvent.keyDown(grid, { key: 'a', ctrlKey: true })
    expect(onSelectionChange).toHaveBeenLastCalledWith(new Set(['note-1', 'note-2']))
    fireEvent.keyDown(grid, { key: 'm', ctrlKey: true, shiftKey: true })
    fireEvent.keyDown(grid, { key: 'Enter' })
    expect(onNoteOpen).toHaveBeenCalledWith('note-1')

    Object.defineProperty(navigator, 'userAgent', {
      configurable: true,
      value: originalUserAgent
    })
  })

  it('renders the kind column when configured', () => {
    render(
      <FolderTableView
        notes={
          [
            { ...notes[0], id: 'n1', title: 'A note', kind: 'note' },
            { ...notes[1], id: 't1', title: 'A task', kind: 'task' }
          ] as any[]
        }
        columns={[
          { id: 'title', width: 300 },
          { id: 'kind', width: 100 }
        ]}
      />
    )

    expect(screen.getByText('Task')).toBeInTheDocument()
  })

  it('treats a row without a kind as a note', () => {
    render(
      <FolderTableView
        notes={[{ ...notes[0], id: 'n1', title: 'A note' }] as any[]}
        columns={[
          { id: 'title', width: 300 },
          { id: 'kind', width: 100 }
        ]}
      />
    )

    expect(screen.getByText('Note')).toBeInTheDocument()
  })
})

describe('GroupedTable', () => {
  it('renders group headers, group summaries, row actions, and keyboard selection', () => {
    const onNoteOpen = vi.fn()
    const onSelectionChange = vi.fn()

    render(
      <GroupedTable
        notes={notes}
        columns={columns}
        formulas={{ double: 'score * 2' }}
        propertyTypes={{ score: 'number' }}
        groupBy={{ property: 'status', showSummary: true } as any}
        onNoteOpen={onNoteOpen}
        onSelectionChange={onSelectionChange}
        showSummaries
        summaries={{ score: { type: 'sum' } as any }}
      />
    )

    expect(screen.getAllByText('Status:')).toHaveLength(2)
    expect(screen.getByText('Open')).toBeInTheDocument()
    expect(screen.getAllByText('1 note')).toHaveLength(2)
    expect(screen.getAllByText(/Score:/)).toHaveLength(2)

    fireEvent.click(screen.getByRole('button', { name: /Alpha plan/ }))
    expect(onNoteOpen).toHaveBeenCalledWith('note-1')

    const grid = screen.getByRole('grid', { name: 'groupedNotesTable' })
    const firstRow = grid.querySelector('[data-row-id="note-1"]')
    fireEvent.click(firstRow as HTMLElement)
    expect(onSelectionChange).toHaveBeenLastCalledWith(new Set(['note-1']))

    fireEvent.keyDown(grid, { key: 'ArrowDown' })
    expect(onSelectionChange).toHaveBeenLastCalledWith(new Set(['note-2']))
  })

  it('drives grouped selection from the select-all header and per-row checkboxes', () => {
    const onSelectionChange = vi.fn()
    render(
      <GroupedTable
        notes={notes}
        columns={columns}
        groupBy={{ property: 'status' } as any}
        onSelectionChange={onSelectionChange}
      />
    )

    fireEvent.click(screen.getByRole('checkbox', { name: 'selectAll' }))
    expect(onSelectionChange).toHaveBeenLastCalledWith(new Set(['note-1', 'note-2']))

    expect(screen.getAllByRole('checkbox', { name: 'selectRow' })).toHaveLength(2)
    const grid = screen.getByRole('grid', { name: 'groupedNotesTable' })
    const note1Box = grid
      .querySelector('[data-row-id="note-1"]')!
      .querySelector('[role="checkbox"]') as HTMLElement
    fireEvent.click(note1Box)
    expect(onSelectionChange).toHaveBeenLastCalledWith(new Set(['note-2']))
  })

  it('renders grouped loading, empty, and no-results states', () => {
    const onCreateNote = vi.fn()
    const onClearAll = vi.fn()
    const { rerender } = render(<GroupedTable notes={notes} columns={columns} isLoading />)
    expect(screen.getByText('loading')).toBeInTheDocument()

    rerender(<GroupedTable notes={[]} columns={columns} onCreateNote={onCreateNote} />)
    fireEvent.click(screen.getByRole('button', { name: 'create empty' }))
    expect(onCreateNote).toHaveBeenCalled()

    rerender(
      <GroupedTable
        notes={notes}
        columns={columns}
        globalFilter="missing"
        onClearAll={onClearAll}
      />
    )
    fireEvent.click(screen.getByRole('button', { name: 'clear empty' }))
    expect(onClearAll).toHaveBeenCalled()
  })

  it('covers grouped table built-in cells, collapsed groups, formulas, and selection variants', () => {
    const onNoteOpen = vi.fn()
    const onSelectionChange = vi.fn()
    const onColumnsChange = vi.fn()
    const onMoveToFolder = vi.fn()
    const branchNotes = [
      {
        ...notes[0],
        id: 'note-1',
        title: 'Alpha plan',
        properties: { score: 3, done: false, status: '' }
      },
      {
        ...notes[1],
        id: 'note-2',
        title: 'Beta brief',
        properties: { score: 7, done: true, status: ['Done', 'Reviewed'] }
      }
    ] as any[]
    const branchColumns = [
      { id: 'title', displayName: 'Title', width: 220 },
      { id: 'score', displayName: 'Score', width: 100 },
      { id: 'created', displayName: 'Created', width: 130 },
      { id: 'modified', displayName: 'Modified', width: 130 },
      { id: 'wordCount', displayName: 'Words', width: 80 },
      { id: 'done', displayName: 'Done', width: 80 },
      { id: 'formula.isLarge', displayName: 'Large?', width: 100 },
      { id: 'formula.missing', displayName: 'Missing Formula', width: 100 }
    ] as any[]

    const { rerender } = render(
      <GroupedTable
        notes={branchNotes}
        columns={branchColumns}
        formulas={{ isLarge: 'score > 5' }}
        propertyTypes={{ done: 'checkbox' }}
        groupBy={{ property: 'status', collapsed: true, showSummary: true } as any}
        initialSorting={[{ property: 'score', direction: 'asc' }]}
        onNoteOpen={onNoteOpen}
        onSelectionChange={onSelectionChange}
        onColumnsChange={onColumnsChange}
        onMoveToFolder={onMoveToFolder}
        showColumnBorders
        density="compact"
        exitingRowIds={new Set(['note-2'])}
        showSummaries
        summaries={{
          score: { type: 'sum' } as any,
          wordCount: { type: 'avg' } as any,
          done: { type: 'count' } as any,
          title: { type: 'count' } as any
        }}
      />
    )

    expect(screen.getByText('(Empty)')).toBeInTheDocument()
    expect(screen.getByText('Done,Reviewed')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /Alpha plan/ })).not.toBeInTheDocument()

    fireEvent.click(screen.getByText('(Empty)').closest('tr')!)
    fireEvent.click(screen.getByRole('button', { name: /Alpha plan/ }))
    expect(onNoteOpen).toHaveBeenCalledWith('note-1')

    const grid = screen.getByRole('grid', { name: 'groupedNotesTable' })
    const firstRow = grid.querySelector('[data-row-id="note-1"]') as HTMLElement
    fireEvent.click(firstRow)
    expect(onSelectionChange).toHaveBeenLastCalledWith(new Set(['note-1']))
    fireEvent.click(screen.getByText('Done,Reviewed').closest('tr')!)
    const secondRow = grid.querySelector('[data-row-id="note-2"]') as HTMLElement
    fireEvent.click(secondRow, { shiftKey: true })
    expect(onSelectionChange).toHaveBeenLastCalledWith(new Set(['note-1', 'note-2']))
    fireEvent.click(firstRow, { metaKey: true })
    expect(onSelectionChange).toHaveBeenLastCalledWith(new Set(['note-2']))

    fireEvent.keyDown(grid, { key: 'ArrowUp' })
    expect(onSelectionChange).toHaveBeenLastCalledWith(new Set(['note-2']))
    fireEvent.keyDown(grid, { key: ' ', code: 'Space' })
    expect(onSelectionChange).toHaveBeenLastCalledWith(new Set(['note-2']))
    fireEvent.keyDown(grid, { key: 'Escape' })
    expect(onSelectionChange).toHaveBeenLastCalledWith(new Set())

    fireEvent.click(screen.getByRole('button', { name: 'mock drag' }))
    expect(onColumnsChange).toHaveBeenCalled()

    rerender(
      <GroupedTable
        notes={branchNotes}
        columns={branchColumns}
        formulas={{ isLarge: 'score > 5' }}
        propertyTypes={{ done: 'checkbox' }}
        groupBy={{ property: 'folder', collapsed: false } as any}
        selectedRowIds={new Set(['note-1', 'note-2'])}
        onMoveToFolder={onMoveToFolder}
      />
    )

    fireEvent.keyDown(screen.getByRole('grid', { name: 'groupedNotesTable' }), {
      key: 'm',
      ctrlKey: true,
      shiftKey: true
    })
    expect(onMoveToFolder).toHaveBeenCalledWith(['note-1', 'note-2'])
  })

  it('handles grouped keyboard wrap edges, hidden grouping columns, and no-op callbacks', () => {
    const onNoteOpen = vi.fn()
    const onSelectionChange = vi.fn()
    const branchNotes = [
      {
        ...notes[0],
        folder: '/',
        properties: { ...notes[0].properties, keywords: ['review', 'plan'] }
      },
      {
        ...notes[1],
        properties: { ...notes[1].properties, keywords: [] }
      }
    ] as any[]
    const branchColumns = [{ id: 'title', displayName: 'Title', width: 180 }] as any[]

    render(
      <GroupedTable
        notes={branchNotes}
        columns={branchColumns}
        propertyTypes={{ keywords: 'multiselect' }}
        groupBy={{ property: 'keywords', collapsed: false, showSummary: true } as any}
        initialSorting={[
          { property: 'folder', direction: 'asc' },
          { property: 'tags', direction: 'asc' },
          { property: 'created', direction: 'asc' },
          { property: 'modified', direction: 'desc' },
          { property: 'wordCount', direction: 'desc' }
        ]}
        onNoteOpen={onNoteOpen}
        onSelectionChange={onSelectionChange}
        showSummaries
        summaries={{ title: { type: 'count' } as any }}
      />
    )

    expect(screen.getByText('review,plan')).toBeInTheDocument()
    expect(screen.getByText('(Empty)')).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'resize title' }))
    fireEvent.click(screen.getByRole('button', { name: 'mock drag' }))

    const grid = screen.getByRole('grid', { name: 'groupedNotesTable' })
    fireEvent.keyDown(grid, { key: 'ArrowDown' })
    expect(onSelectionChange).toHaveBeenLastCalledWith(new Set(['note-2']))
    fireEvent.keyDown(grid, { key: 'ArrowDown' })
    expect(onSelectionChange).toHaveBeenLastCalledWith(new Set(['note-1']))
    fireEvent.keyDown(grid, { key: 'ArrowDown' })
    expect(onSelectionChange).toHaveBeenLastCalledWith(new Set(['note-2']))
    fireEvent.keyDown(grid, { key: 'ArrowUp' })
    expect(onSelectionChange).toHaveBeenLastCalledWith(new Set(['note-1']))
    fireEvent.keyDown(grid, { key: 'ArrowUp', shiftKey: true })
    expect(onSelectionChange).toHaveBeenLastCalledWith(new Set(['note-2', 'note-1']))
    fireEvent.keyDown(grid, { key: ' ', code: 'Space' })
    expect(onSelectionChange).toHaveBeenLastCalledWith(new Set(['note-1']))
    fireEvent.keyDown(grid, { key: 'a', ctrlKey: true })
    expect(onSelectionChange).toHaveBeenLastCalledWith(new Set(['note-1', 'note-2']))
    fireEvent.keyDown(grid, { key: 'm', ctrlKey: true, shiftKey: true })
    fireEvent.keyDown(grid, { key: 'Enter' })
    expect(onNoteOpen).toHaveBeenCalledWith('note-1')
  })

  it('covers grouped row click guards, double-click open, no-op drags, and chevron toggles', () => {
    const onNoteOpen = vi.fn()
    const onSelectionChange = vi.fn()
    const onColumnsChange = vi.fn()

    render(
      <GroupedTable
        notes={notes}
        columns={columns}
        formulas={{ double: 'score * 2' }}
        propertyTypes={{ score: 'number' }}
        groupBy={{ property: 'status', collapsed: false } as any}
        onNoteOpen={onNoteOpen}
        onSelectionChange={onSelectionChange}
        onColumnsChange={onColumnsChange}
      />
    )

    const titleButton = screen.getByRole('button', { name: /Alpha plan/ })
    fireEvent.click(titleButton)
    expect(onNoteOpen).toHaveBeenCalledWith('note-1')
    expect(onSelectionChange).not.toHaveBeenCalled()

    const grid = screen.getByRole('grid', { name: 'groupedNotesTable' })
    const firstRow = grid.querySelector('[data-row-id="note-1"]') as HTMLElement
    fireEvent.doubleClick(firstRow)
    expect(onNoteOpen).toHaveBeenCalledWith('note-1')

    fireEvent.click(firstRow)
    expect(onSelectionChange).toHaveBeenLastCalledWith(new Set(['note-1']))
    fireEvent.keyDown(grid, { key: 'ArrowUp', shiftKey: true })
    expect(onSelectionChange).toHaveBeenLastCalledWith(new Set(['note-1']))
    fireEvent.keyDown(grid, { key: 'ArrowDown' })
    expect(onSelectionChange).toHaveBeenLastCalledWith(new Set(['note-2']))
    fireEvent.keyDown(grid, { key: 'ArrowDown', shiftKey: true })
    expect(onSelectionChange).toHaveBeenLastCalledWith(new Set(['note-2']))

    fireEvent.click(screen.getByRole('button', { name: 'mock drag same' }))
    fireEvent.click(screen.getByRole('button', { name: 'mock drag none' }))
    fireEvent.click(screen.getByRole('button', { name: 'mock drag invalid' }))
    expect(onColumnsChange).not.toHaveBeenCalled()

    const groupToggle = screen.getByText('Open').closest('tr')?.querySelector('button')
    fireEvent.click(groupToggle as HTMLButtonElement)
    expect(screen.queryByRole('button', { name: /Alpha plan/ })).not.toBeInTheDocument()
  })
})
