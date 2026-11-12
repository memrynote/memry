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

import { fireEvent, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { BlockNoteEditor } from '@blocknote/core'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { GetPropertyRowsOutput } from '@memry/contracts/journal-api'
import type { NoteWithProperties } from '@/hooks/use-folder-view'
import { NEW_NOTE_TITLE } from '@/lib/new-note-title'
import { addDays, localDayKey } from '@/lib/property-chart/chart-model'

const mocks = vi.hoisted(() => {
  const folderView: {
    rows: NoteWithProperties[]
    properties: Array<{ name: string; type: string; usageCount: number }>
    scope: unknown
    initialViewName: string | undefined
  } = { rows: [], properties: [], scope: null, initialViewName: undefined }
  return {
    openSidebarItem: vi.fn(),
    getPropertyRows: vi.fn(),
    createNote: vi.fn(),
    openPage: vi.fn(),
    getFolders: vi.fn(),
    createFolder: vi.fn(),
    toastError: vi.fn(),
    folderView
  }
})

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
  notesKeys: { folders: () => ['notes', 'folders'] },
  useNoteTagsQuery: () => ({ tags: [] }),
  useNoteFoldersQuery: () => ({ folders: [{ path: 'Projects' }] }),
  useNoteMutations: () => ({ createNote: { mutateAsync: mocks.createNote } })
}))
vi.mock('@/hooks/use-open-target', () => ({ useOpenPage: () => ({ openPage: mocks.openPage }) }))
vi.mock('@/services/notes-service', () => ({
  notesService: { getFolders: mocks.getFolders, createFolder: mocks.createFolder }
}))
vi.mock('sonner', () => ({ toast: { error: mocks.toastError } }))
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
import {
  getChartSlashMenuItem,
  getNewViewSlashMenuItem,
  getViewSlashMenuItem,
  ViewBlockRenderer
} from './view-block'

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

function fakeEditor(overrides: { isEditable?: boolean } = {}) {
  return {
    isEditable: overrides.isEditable ?? true,
    updateBlock: vi.fn(),
    nestBlock: vi.fn(),
    unnestBlock: vi.fn(),
    insertBlocks: vi.fn(),
    setTextCursorPosition: vi.fn()
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

  it('creates a note in the source folder and opens it', async () => {
    // #given
    mocks.createNote.mockResolvedValue({
      success: true,
      note: { id: 'n1', title: 'Untitled', emoji: null }
    })
    renderBlock(JSON.stringify({ source: { kind: 'folder', path: 'Work/Specs' } }))

    // #when
    await userEvent.click(screen.getByRole('button', { name: 'New note' }))

    // #then it lands where the block lists it, and opens like the folder page's
    expect(mocks.createNote).toHaveBeenCalledWith({ title: NEW_NOTE_TITLE, folder: 'Work/Specs' })
    expect(mocks.openPage).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'note', entityId: 'n1' })
    )
  })

  it('never shows its definition JSON', () => {
    renderBlock(JSON.stringify({ source: { kind: 'vault' } }))
    expect(screen.queryByText('Definition')).toBeNull()
  })

  it('offers a source in place of a definition it cannot read', async () => {
    // #given a definition whose JSON is broken
    const editor = renderBlock('{"source": ')
    expect(screen.getByText(/can’t be read/)).toBeInTheDocument()

    // #when a source is picked
    await userEvent.click(screen.getByTestId('view-block-source'))
    await userEvent.click(await screen.findByRole('menuitem', { name: /vault|all notes/i }))

    // #then the block is rewritten over it
    expect(editor.updateBlock).toHaveBeenCalledWith('view-1', {
      content: expect.stringContaining('"kind": "vault"')
    })
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

  function mountEditor() {
    const editor = BlockNoteEditor.create({ schema: editorSchema })
    const element = document.createElement('div')
    document.body.appendChild(element)
    editor.mount(element)
    mounted.push({ editor: editor as unknown as BlockNoteEditor, element })
    editor.replaceBlocks(editor.document, [{ type: 'paragraph' }])
    editor.setTextCursorPosition(editor.document[0], 'end')
    return editor
  }

  const newViewLabels = { title: 'New view', group: 'Insert', subtext: '', failed: 'Failed' }

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

  it('/new view makes a numbered Untitled View beside the note and lists it', async () => {
    // #given the note's folder already holds an Untitled View
    mocks.getFolders.mockResolvedValue([{ path: 'Projects' }, { path: 'Projects/Untitled View' }])
    mocks.createFolder.mockResolvedValue({ success: true })
    const editor = mountEditor()

    // #when
    getNewViewSlashMenuItem(editor, newViewLabels, async () => 'Projects/Plan.md').onItemClick()

    // #then the next free name is created, and the block lists that folder
    await vi.waitFor(() => expect(editor.document[0].type).toBe('codeBlock'))
    expect(mocks.createFolder).toHaveBeenCalledWith('Projects/Untitled View 2')
    const [view] = editor.document
    const text = (view.content as Array<{ text: string }>).map((run) => run.text).join('')
    expect(JSON.parse(text)).toEqual({
      source: { kind: 'folder', path: 'Projects/Untitled View 2' },
      layout: 'list',
      order: [{ property: 'modified', direction: 'desc' }]
    })
  })

  it('/new view inserts nothing and says so when the folder cannot be made', async () => {
    mocks.getFolders.mockResolvedValue([])
    mocks.createFolder.mockResolvedValue({ success: false, error: 'Folder is locked' })
    const editor = mountEditor()

    getNewViewSlashMenuItem(editor, newViewLabels, async () => 'Plan.md').onItemClick()

    await vi.waitFor(() => expect(mocks.toastError).toHaveBeenCalledWith('Folder is locked'))
    expect(mocks.createFolder).toHaveBeenCalledWith('Untitled View')
    expect(editor.document.map((block) => block.type)).toEqual(['paragraph'])
  })
})
