/**
 * The view block (#2488): a `memry-view` code block drawn as a live list.
 *
 * The rows come from the folder view's own hook, whose freshness is
 * use-folder-view's subject; here it is a stub holding a fixed set of rows.
 * What is only true here is the block's contract around it: that its own
 * filters, order and limit narrow the source, that a row opens where the
 * folder page would open it, that every control writes the definition back
 * into the document without losing keys a newer build wrote, and that `/view`
 * leaves a code block the rest of the pipeline already knows. A journal source
 * reads entries by day range instead, stubbed at the journal service.
 */

import { act, fireEvent, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { BlockNoteEditor } from '@blocknote/core'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { GetPropertyRowsOutput } from '@memry/contracts/journal-api'
import type { NoteWithProperties } from '@/hooks/use-folder-view'
import { addDays, localDayKey } from '@/lib/property-chart/chart-model'

const mocks = vi.hoisted(() => ({
  openSidebarItem: vi.fn(),
  getPropertyRows: vi.fn(),
  folderView: {
    rows: [] as NoteWithProperties[],
    properties: [] as Array<{ name: string; type: string; usageCount: number }>,
    scope: null as unknown,
    initialViewName: undefined as string | undefined
  }
}))

// pdf.js touches `DOMMatrix` at import time, which jsdom has none of. The rest
// of the schema is real.
vi.mock('react-pdf', () => ({
  Document: () => null,
  Page: () => null,
  pdfjs: { GlobalWorkerOptions: { workerSrc: '' } }
}))
vi.mock('@/hooks/use-sidebar-navigation', () => ({
  useSidebarNavigation: () => ({ openSidebarItem: mocks.openSidebarItem })
}))
vi.mock('@/hooks/use-notes-query', () => ({
  useNoteTagsQuery: () => ({ tags: [] }),
  useNoteFoldersQuery: () => ({ folders: [{ path: 'Projects' }] })
}))
vi.mock('@/services/journal-service', () => ({
  journalService: { getPropertyRows: mocks.getPropertyRows }
}))
vi.mock('@/hooks/use-property-definitions', () => ({
  usePropertyDefinitions: () => ({ getDefinition: () => undefined })
}))
vi.mock('@/hooks/use-folder-view', () => ({
  useFolderView: ({ scope, initialViewName }: { scope: unknown; initialViewName?: string }) => {
    mocks.folderView.scope = scope
    mocks.folderView.initialViewName = initialViewName
    return {
      views: [{ name: 'Default', type: 'table' }],
      activeView: { name: 'Default', type: 'table' },
      notes: mocks.folderView.rows,
      unfilteredCount: mocks.folderView.rows.length,
      hasMore: false,
      loadMore: vi.fn(),
      availableProperties: mocks.folderView.properties,
      builtInColumns: [{ id: 'title', displayName: 'Title', type: 'text' }],
      formulasMap: {},
      isLoading: false,
      error: null,
      folderNotFound: false
    }
  }
}))

import { editorSchema } from './editor-schema'
import { getChartSlashMenuItem, getViewSlashMenuItem, ViewBlockRenderer } from './view-block'

function row(id: string, overrides: Partial<NoteWithProperties> = {}): NoteWithProperties {
  return {
    id,
    path: `notes/${id}.md`,
    title: id,
    emoji: null,
    folder: '/',
    tags: [],
    created: '2026-01-01T00:00:00.000Z',
    modified: '2026-01-01T00:00:00.000Z',
    wordCount: 0,
    properties: {},
    ...overrides
  }
}

function fakeEditor(overrides: { caretBlockId?: string; isEditable?: boolean } = {}) {
  let caret = overrides.caretBlockId ?? 'elsewhere'
  const listeners = new Set<() => void>()
  return {
    isEditable: overrides.isEditable ?? true,
    focus: vi.fn(),
    updateBlock: vi.fn(),
    getTextCursorPosition: () => ({ block: { id: caret } }),
    onSelectionChange: (listener: () => void) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    moveCaret: (id: string) => {
      caret = id
      for (const listener of listeners) listener()
    }
  }
}

function renderBlock(definition: string, editor = fakeEditor()) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  render(
    <QueryClientProvider client={queryClient}>
      <ViewBlockRenderer
        block={{
          id: 'view-1',
          props: { language: 'memry-view' },
          content: [{ type: 'text', text: definition, styles: {} }]
        }}
        editor={editor}
        contentRef={() => {}}
      />
    </QueryClientProvider>
  )
  return editor
}

describe('ViewBlockRenderer', () => {
  beforeEach(() => {
    mocks.openSidebarItem.mockReset()
    mocks.folderView.rows = []
  })

  it('narrows the source by its own filters, order and limit', () => {
    // #given four notes under a tag
    mocks.folderView.rows = [
      row('Alpha', { tags: ['inbox-thought'], created: '2026-03-01T00:00:00.000Z' }),
      row('Bravo', { tags: ['inbox-thought'], created: '2026-03-04T00:00:00.000Z' }),
      row('Charlie', { tags: ['inbox-thought'], created: '2026-03-03T00:00:00.000Z' }),
      row('Old', { tags: ['inbox-thought'], created: '2026-01-01T00:00:00.000Z' })
    ]

    // #when the block keeps this month's, newest first, two at most
    renderBlock(
      JSON.stringify({
        source: { kind: 'tag', tag: 'inbox-thought' },
        layout: 'list',
        filters: 'created after "2026-02-28"',
        order: [{ property: 'created', direction: 'desc' }],
        limit: 2
      })
    )

    // #then it read the tag, and shows the two newest of the three that match
    expect(mocks.folderView.scope).toEqual({ kind: 'tag', tag: 'inbox-thought' })
    const titles = screen.getAllByRole('button', { name: /Alpha|Bravo|Charlie|Old/ })
    expect(titles.map((el) => el.textContent?.match(/Alpha|Bravo|Charlie|Old/)?.[0])).toEqual([
      'Bravo',
      'Charlie'
    ])
  })

  it('reads the whole vault through the root folder and passes the saved view on', () => {
    renderBlock(JSON.stringify({ source: { kind: 'vault' }, view: 'Recent' }))

    expect(mocks.folderView.scope).toEqual({ kind: 'folder', path: '' })
    expect(mocks.folderView.initialViewName).toBe('Recent')
  })

  it('opens a row on click, and in a background tab on middle-click', () => {
    // #given
    mocks.folderView.rows = [row('Alpha'), row('Task', { kind: 'task', path: '/tasks/Task' })]
    renderBlock(JSON.stringify({ source: { kind: 'vault' }, layout: 'list' }))

    // #when
    fireEvent.click(screen.getByRole('button', { name: /Alpha/ }))
    fireEvent.mouseDown(screen.getByRole('button', { name: /Task/ }), { button: 1 })

    // #then a note opens as a note, a task on the Tasks page, as the folder page does
    expect(mocks.openSidebarItem).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ type: 'note', entityId: 'Alpha' }),
      undefined
    )
    expect(mocks.openSidebarItem).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        type: 'tasks',
        viewState: expect.objectContaining({ openTaskId: 'Task' })
      }),
      { inNewTab: true, inBackground: true }
    )
  })

  it('writes a layout change back into the definition, keeping keys it does not know', async () => {
    // #given a definition a newer build wrote
    mocks.folderView.rows = [row('Alpha')]
    const editor = renderBlock(
      JSON.stringify({ source: { kind: 'vault' }, layout: 'list', groupBy: 'folder' })
    )

    // #when
    await userEvent.click(screen.getByRole('button', { name: 'Table' }))

    // #then
    expect(editor.updateBlock).toHaveBeenCalledTimes(1)
    const [id, update] = editor.updateBlock.mock.calls[0] as [string, { content: string }]
    expect(id).toBe('view-1')
    expect(JSON.parse(update.content)).toEqual({
      source: { kind: 'vault' },
      layout: 'table',
      groupBy: 'folder'
    })
  })

  it('opens the source as a tab', async () => {
    renderBlock(JSON.stringify({ source: { kind: 'folder', path: 'Work/Specs' }, view: 'Open' }))

    await userEvent.click(screen.getByRole('button', { name: 'Open as tab' }))

    expect(mocks.openSidebarItem).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'folder',
        entityId: 'Work/Specs',
        viewState: { folderViewName: 'Open' }
      })
    )
  })

  it('shows the definition to fix when its JSON is broken', () => {
    renderBlock('{"source": ')

    expect(screen.getByText(/not valid JSON/)).toBeInTheDocument()
    expect(screen.getByText('Definition').parentElement).not.toHaveClass('hidden')
  })

  it('keeps the definition hidden until the caret is in the block', () => {
    renderBlock(JSON.stringify({ source: { kind: 'vault' } }))
    expect(screen.getByText('Definition').parentElement).toHaveClass('hidden')
  })

  it('shows the definition while the caret is in the block', () => {
    renderBlock(
      JSON.stringify({ source: { kind: 'vault' } }),
      fakeEditor({ caretBlockId: 'view-1' })
    )
    expect(screen.getByText('Definition').parentElement).not.toHaveClass('hidden')
  })

  it('shows the definition and re-focuses the editor when the caret moves in', () => {
    // #given the caret elsewhere
    const editor = renderBlock(JSON.stringify({ source: { kind: 'vault' } }))
    expect(screen.getByText('Definition').parentElement).toHaveClass('hidden')

    // #when it moves into the block
    act(() => editor.moveCaret('view-1'))

    // #then the definition shows, and the DOM selection is written again now
    // that there is a visible element to hold it
    expect(screen.getByText('Definition').parentElement).not.toHaveClass('hidden')
    expect(editor.focus).toHaveBeenCalledTimes(1)
  })

  it('does not take focus when it mounts with the caret already inside', () => {
    const editor = renderBlock(
      JSON.stringify({ source: { kind: 'vault' } }),
      fakeEditor({ caretBlockId: 'view-1' })
    )
    expect(editor.focus).not.toHaveBeenCalled()
  })

  it('offers no controls in a read-only editor', () => {
    renderBlock(JSON.stringify({ source: { kind: 'vault' } }), fakeEditor({ isEditable: false }))

    expect(screen.queryByRole('button', { name: 'Table' })).toBeNull()
    expect(screen.getByTestId('view-block-source')).toBeDisabled()
  })
})

describe('ViewBlockRenderer over the journal', () => {
  beforeEach(() => {
    mocks.openSidebarItem.mockReset()
    mocks.getPropertyRows.mockReset()
    // jsdom lays nothing out; the chart draws only once it has a width.
    vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(640)
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('charts a checkbox as a streak heatmap and opens a day in the journal', async () => {
    // #given two journal days in a row with the workout checked
    const today = localDayKey(new Date())
    const yesterday = addDays(today, -1)
    const entry = (id: string, date: string) => ({
      id,
      date,
      path: `journal/${date}.md`,
      title: date,
      properties: { workout: true }
    })
    mocks.getPropertyRows.mockResolvedValue({
      rows: [entry('j1', yesterday), entry('j2', today)],
      properties: [{ name: 'workout', type: 'checkbox', count: 2 }]
    } satisfies GetPropertyRowsOutput)

    // #when the block charts it without naming a chart type
    renderBlock(
      JSON.stringify({
        source: { kind: 'journal' },
        layout: 'chart',
        chart: { property: 'workout' }
      })
    )

    // #then the checkbox picked the heatmap, over half a year ending today
    const chart = await screen.findByRole('img', { name: 'workout over the last 182 days' })
    const [from, to] = mocks.getPropertyRows.mock.calls[0] as [string, string]
    expect(to).toBe(today)
    expect(from).toBe(addDays(today, -363))
    expect(screen.getByText('Current streak').nextElementSibling).toHaveTextContent('2 days')

    // #and today's square opens today's entry
    const cells = chart.querySelectorAll('rect')
    fireEvent.click(cells[cells.length - 1])
    expect(mocks.openSidebarItem).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'journal', viewState: { date: today } })
    )
  })

  it('turns the block into a chart when the journal is picked as its source', async () => {
    // #given a list over the vault
    mocks.getPropertyRows.mockResolvedValue({ rows: [], properties: [] })
    const editor = renderBlock(JSON.stringify({ source: { kind: 'vault' }, layout: 'list' }))

    // #when
    await userEvent.click(screen.getByTestId('view-block-source'))
    await userEvent.click(await screen.findByRole('menuitem', { name: 'Journal' }))

    // #then the journal has no list here, so the layout follows
    const [, update] = editor.updateBlock.mock.calls[0] as [string, { content: string }]
    expect(JSON.parse(update.content)).toEqual({
      source: { kind: 'journal' },
      layout: 'chart'
    })
  })
})

describe('ViewBlockRenderer chart over a tag', () => {
  beforeEach(() => {
    mocks.openSidebarItem.mockReset()
    vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(640)
  })

  afterEach(() => {
    vi.restoreAllMocks()
    mocks.folderView.properties = []
  })

  it('plots every matching note, ignoring the list limit, and opens the note on a day', () => {
    // #given two rated notes, created yesterday and today, under a block limited to one row
    const today = localDayKey(new Date())
    const at = (day: string) => new Date(`${day}T12:00:00`).toISOString()
    mocks.folderView.properties = [{ name: 'rating', type: 'number', usageCount: 2 }]
    mocks.folderView.rows = [
      row('Old', { created: at(addDays(today, -1)), properties: { rating: 3 } }),
      row('New', { created: at(today), properties: { rating: 5 } })
    ]

    renderBlock(
      JSON.stringify({
        source: { kind: 'tag', tag: 'reading' },
        layout: 'chart',
        limit: 1,
        chart: { property: 'rating', type: 'bar', rangeDays: 7 }
      })
    )

    // #then both notes are bars: a limit shapes a list, not a range
    const chart = screen.getByRole('img', { name: 'rating over the last 7 days' })
    expect(chart.querySelectorAll('rect')).toHaveLength(2)

    // #when today's bar is clicked
    fireEvent.pointerMove(chart, { clientX: 630 })
    fireEvent.click(chart)
    expect(mocks.openSidebarItem).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'note', entityId: 'New' }),
      undefined
    )
  })
})

describe('/view', () => {
  const mounted: Array<{ editor: BlockNoteEditor; element: HTMLElement }> = []

  afterEach(() => {
    for (const { editor, element } of mounted.splice(0)) {
      editor._tiptapEditor.destroy()
      element.remove()
    }
  })

  it('turns the empty line into a memry-view code block and leaves the caret below it', () => {
    // #given
    const editor = BlockNoteEditor.create({ schema: editorSchema })
    const element = document.createElement('div')
    document.body.appendChild(element)
    editor.mount(element)
    mounted.push({ editor: editor as unknown as BlockNoteEditor, element })
    editor.replaceBlocks(editor.document, [
      { type: 'paragraph', content: 'Intro' },
      { type: 'paragraph' }
    ])
    editor.setTextCursorPosition(editor.document[1], 'end')

    // #when
    getViewSlashMenuItem(editor, { title: 'View', group: 'Insert', subtext: '' }).onItemClick()

    // #then the block is a plain code block to every pipeline
    const [, view, after] = editor.document
    expect(editor.document.map((block) => block.type)).toEqual([
      'paragraph',
      'codeBlock',
      'paragraph'
    ])
    expect(view.props).toEqual({ language: 'memry-view' })
    const text = (view.content as Array<{ text: string }>).map((run) => run.text).join('')
    expect(JSON.parse(text)).toEqual({
      source: { kind: 'vault' },
      layout: 'list',
      order: [{ property: 'modified', direction: 'desc' }],
      limit: 10
    })
    // and typing goes into the note, not into the JSON
    expect(editor.getTextCursorPosition().block.id).toBe(after.id)
  })

  it('/chart inserts the same block as a journal chart with no property yet', () => {
    const editor = BlockNoteEditor.create({ schema: editorSchema })
    const element = document.createElement('div')
    document.body.appendChild(element)
    editor.mount(element)
    mounted.push({ editor: editor as unknown as BlockNoteEditor, element })
    editor.replaceBlocks(editor.document, [{ type: 'paragraph' }])
    editor.setTextCursorPosition(editor.document[0], 'end')

    getChartSlashMenuItem(editor, { title: 'Chart', group: 'Insert', subtext: '' }).onItemClick()

    const [chart] = editor.document
    expect(chart.props).toEqual({ language: 'memry-view' })
    const text = (chart.content as Array<{ text: string }>).map((run) => run.text).join('')
    expect(JSON.parse(text)).toEqual({
      source: { kind: 'journal' },
      layout: 'chart',
      chart: {}
    })
  })
})
