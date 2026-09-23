import { act, fireEvent, renderHook } from '@testing-library/react'
import { beforeEach, afterEach, describe, expect, it, vi, type Mock } from 'vitest'
import { useMentionSuggestions, type UseMentionSuggestionsOptions } from './use-mention-suggestions'
import type { MentionSuggestionItem } from '../mention-menu'

const mocks = vi.hoisted(() => ({
  listNotes: vi.fn(),
  listTitledCanvases: vi.fn(),
  logger: { error: vi.fn() }
}))

vi.mock('@/services/notes-service', () => ({
  notesService: {
    list: (...args: unknown[]) => mocks.listNotes(...args)
  }
}))

vi.mock('@/lib/canvas-lookup', () => ({
  listTitledCanvases: () => mocks.listTitledCanvases()
}))

vi.mock('@/lib/logger', () => ({
  createLogger: () => mocks.logger
}))

function makeNotes(n: number) {
  return Array.from({ length: n }, (_, i) => ({
    id: `note-${i}`,
    title: `Note ${i}`,
    modified: new Date(`2026-05-${String((i % 28) + 1).padStart(2, '0')}T00:00:00.000Z`)
  }))
}

function options(overrides: Partial<UseMentionSuggestionsOptions> = {}) {
  return {
    onInsertDate: vi.fn(),
    editorContainerRef: { current: null },
    canvasesEnabled: true,
    ...overrides
  }
}

describe('useMentionSuggestions', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-05-10T12:00:00.000Z'))
    mocks.listNotes.mockResolvedValue({ notes: makeNotes(3) })
    mocks.listTitledCanvases.mockResolvedValue([])
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('puts the Date group (date + remind) first then notes on an empty query', async () => {
    const editor = { insertInlineContent: vi.fn() }
    const { result } = renderHook(() => useMentionSuggestions(editor, options()))

    let items: MentionSuggestionItem[] = []
    await act(async () => {
      items = await result.current.getMentionItems('')
    })

    expect(mocks.listNotes).toHaveBeenCalledWith({ limit: 500, sortBy: 'modified' })
    expect(items[0].kind).toBe('date')
    expect(items[1].kind).toBe('remind')
    expect(items.slice(2).every((i) => i.kind === 'note')).toBe(true)
    expect(items).toHaveLength(5)
  })

  it('shows the Date group for a date-parseable query plus filtered notes', async () => {
    mocks.listNotes.mockResolvedValue({
      notes: [
        { id: 'a', title: 'Monday standup' },
        { id: 'b', title: 'Other' }
      ]
    })
    const editor = { insertInlineContent: vi.fn() }
    const { result } = renderHook(() => useMentionSuggestions(editor, options()))

    let items: MentionSuggestionItem[] = []
    await act(async () => {
      items = await result.current.getMentionItems('monday')
    })

    expect(items.some((i) => i.kind === 'date')).toBe(true)
    expect(items.some((i) => i.kind === 'remind')).toBe(true)
    const noteTitles = items.filter((i) => i.kind === 'note').map((i) => (i as any).title)
    expect(noteTitles).toContain('Monday standup')
  })

  it('keeps a date-hint row (no empty result) for a date-ish query that does not parse yet', async () => {
    mocks.listNotes.mockResolvedValue({ notes: [{ id: 'a', title: 'Unrelated note' }] })
    const editor = { insertInlineContent: vi.fn() }
    const { result } = renderHook(() => useMentionSuggestions(editor, options()))

    let items: MentionSuggestionItem[] = []
    await act(async () => {
      items = await result.current.getMentionItems('next')
    })

    expect(items.some((i) => i.kind === 'date-hint')).toBe(true)
    expect(items.some((i) => i.kind === 'date' || i.kind === 'remind')).toBe(false)
  })

  it('shows the best-effort prefix date while a trailing time is being typed', async () => {
    mocks.listNotes.mockResolvedValue({ notes: [{ id: 'a', title: 'Unrelated note' }] })
    const editor = { insertInlineContent: vi.fn() }
    const { result } = renderHook(() => useMentionSuggestions(editor, options()))

    let items: MentionSuggestionItem[] = []
    await act(async () => {
      items = await result.current.getMentionItems('today 12p')
    })

    expect(items.some((i) => i.kind === 'date')).toBe(true)
    expect(items.some((i) => i.kind === 'date-hint')).toBe(false)
  })

  it('ignores a date-hint selection (no insert)', () => {
    const onInsertDate = vi.fn()
    const editor = { insertInlineContent: vi.fn() }
    const { result } = renderHook(() => useMentionSuggestions(editor, options({ onInsertDate })))

    act(() => {
      result.current.handleMentionSelect({ kind: 'date-hint' })
    })

    expect(onInsertDate).not.toHaveBeenCalled()
    expect(editor.insertInlineContent).not.toHaveBeenCalled()
  })

  it('shows notes only (no Date group) for a non-date query', async () => {
    mocks.listNotes.mockResolvedValue({
      notes: [
        { id: 'a', title: 'Meeting A' },
        { id: 'b', title: 'Meeting B' },
        { id: 'c', title: 'Other' }
      ]
    })
    const editor = { insertInlineContent: vi.fn() }
    const { result } = renderHook(() => useMentionSuggestions(editor, options()))

    let items: MentionSuggestionItem[] = []
    await act(async () => {
      items = await result.current.getMentionItems('Meeting')
    })

    expect(items.some((i) => i.kind === 'date' || i.kind === 'remind')).toBe(false)
    const titles = items.map((i) => (i.kind === 'note' ? i.title : '')).sort()
    expect(titles).toEqual(['Meeting A', 'Meeting B'])
  })

  it('caps at 10 notes collapsed (hasMore) and returns all after showMore', async () => {
    mocks.listNotes.mockResolvedValue({ notes: makeNotes(12) })
    const editor = { insertInlineContent: vi.fn() }
    const { result } = renderHook(() => useMentionSuggestions(editor, options()))

    let items: MentionSuggestionItem[] = []
    await act(async () => {
      items = await result.current.getMentionItems('')
    })
    expect(items.filter((i) => i.kind === 'note')).toHaveLength(10)
    expect(result.current.mentionHasMore).toBe(true)

    act(() => {
      result.current.showMore()
    })
    await act(async () => {
      items = await result.current.getMentionItems('')
    })
    expect(items.filter((i) => i.kind === 'note')).toHaveLength(12)
    expect(result.current.mentionHasMore).toBe(false)
  })

  it('inserts a wiki link when a note is selected', () => {
    mocks.listNotes.mockResolvedValue({ notes: makeNotes(1) })
    const editor = { insertInlineContent: vi.fn() }
    const { result } = renderHook(() => useMentionSuggestions(editor, options()))

    act(() => {
      result.current.handleMentionSelect({ kind: 'note', id: 'n1', title: 'Daily Note' })
    })

    expect(editor.insertInlineContent).toHaveBeenCalledWith(
      [{ type: 'wikiLink', props: { target: 'Daily Note', alias: '' } }, ' '],
      { updateSelection: true }
    )
  })

  it('calls onInsertDate when a date or remind item is selected', () => {
    const onInsertDate = vi.fn()
    const editor = { insertInlineContent: vi.fn() }
    const { result } = renderHook(() => useMentionSuggestions(editor, options({ onInsertDate })))

    const value = {
      dateISO: '2026-05-10T09:00:00.000Z',
      hasTime: false,
      dateFormat: 'relative' as const,
      remind: 'at' as const,
      timeFormat: 'system' as const
    }
    act(() => {
      result.current.handleMentionSelect({ kind: 'remind', subtitle: 'Tomorrow 9am', value })
    })

    expect(onInsertDate).toHaveBeenCalledWith(value)
    expect(editor.insertInlineContent).not.toHaveBeenCalled()
  })
})

interface MockEditor {
  insertInlineContent: Mock
  getTextCursorPosition: () => { block: { id: string; content: unknown } }
  updateBlock: Mock
  insertBlocks: Mock
  getNextBlock: Mock
  setTextCursorPosition: Mock
}

describe('useMentionSuggestions canvases', () => {
  const canvas = { kind: 'canvas' as const, id: 'cv1', title: 'Roadmap Board' }
  const wikiLink = [{ type: 'wikiLink', props: { target: 'Roadmap Board', alias: '' } }, ' ']

  /**
   * Returns what BlockNote returns: the updated block, the inserted blocks, and
   * — unless `next` is given — no block after the board.
   */
  function makeEditor(
    block: { id: string; content: unknown },
    next?: { id: string; content: unknown }
  ): MockEditor {
    return {
      insertInlineContent: vi.fn(),
      getTextCursorPosition: () => ({ block }),
      updateBlock: vi.fn((target: { id: string }) => ({ id: target.id })),
      insertBlocks: vi.fn((blocks: Array<{ type: string }>) =>
        blocks.map((b) => ({
          id: `new-${b.type}`,
          content: b.type === 'paragraph' ? [] : undefined
        }))
      ),
      getNextBlock: vi.fn(() => next),
      setTextCursorPosition: vi.fn()
    }
  }

  function renderWithContainer(editor: MockEditor) {
    const container = document.createElement('div')
    document.body.appendChild(container)
    const hook = renderHook(() =>
      useMentionSuggestions(editor, options({ editorContainerRef: { current: container } }))
    )
    act(() => hook.result.current.handleMentionSelect(canvas))
    return { ...hook, container }
  }

  beforeEach(() => {
    vi.clearAllMocks()
    mocks.listNotes.mockResolvedValue({
      notes: [
        { id: 'n1', title: 'Roadmap notes' },
        { id: 'n2', title: 'Other' }
      ]
    })
    mocks.listTitledCanvases.mockResolvedValue([
      { id: 'cv1', title: 'Roadmap Board' },
      { id: 'cv2', title: 'Roadmap Q1' },
      { id: 'cv3', title: 'Roadmap Q2' },
      { id: 'cv4', title: 'Roadmap Q3' },
      { id: 'cv5', title: 'Unrelated' }
    ])
  })
  afterEach(() => {
    document.body.innerHTML = ''
  })

  it('lists matching canvases after the notes, capped until Show more', async () => {
    const editor = makeEditor({ id: 'b1', content: [] })
    const { result } = renderHook(() => useMentionSuggestions(editor, options()))

    let items: MentionSuggestionItem[] = []
    await act(async () => {
      items = await result.current.getMentionItems('roadmap')
    })

    const kinds = items.map((item) => item.kind)
    expect(kinds.lastIndexOf('note')).toBeLessThan(kinds.indexOf('canvas'))
    const canvases = items.filter((item) => item.kind === 'canvas')
    expect(canvases).toHaveLength(3)
    expect(canvases.map((item) => item.title)).not.toContain('Unrelated')
    expect(result.current.mentionHasMore).toBe(true)

    act(() => result.current.showMore())
    await act(async () => {
      items = await result.current.getMentionItems('roadmap')
    })
    expect(items.filter((item) => item.kind === 'canvas')).toHaveLength(4)
  })

  it('offers no canvases while the spatial canvas feature is off', async () => {
    const editor = makeEditor({ id: 'b1', content: [] })
    const { result } = renderHook(() =>
      useMentionSuggestions(editor, options({ canvasesEnabled: false }))
    )

    let items: MentionSuggestionItem[] = []
    await act(async () => {
      items = await result.current.getMentionItems('roadmap')
    })

    expect(items.some((item) => item.kind === 'canvas')).toBe(false)
  })

  it('opens the Mention / Embed choice on pick and inserts nothing yet', () => {
    const editor = makeEditor({ id: 'b1', content: [] })
    const { result } = renderWithContainer(editor)

    expect(result.current.canvasChoice).toMatchObject({
      canvas: { id: 'cv1', title: 'Roadmap Board' },
      selectedIndex: 0
    })
    expect(editor.insertInlineContent).not.toHaveBeenCalled()
  })

  it('Mention inserts the canvas wiki-link, as the [[ menu does', () => {
    const editor = makeEditor({ id: 'b1', content: [] })
    const { result } = renderWithContainer(editor)

    act(() => result.current.selectCanvasChoice('mention'))

    expect(editor.insertInlineContent).toHaveBeenCalledWith(wikiLink, { updateSelection: true })
    expect(editor.updateBlock).not.toHaveBeenCalled()
    expect(result.current.canvasChoice).toBeNull()
  })

  it('Embed turns the line the @query emptied into a whiteboard block', () => {
    const block = { id: 'b1', content: [] }
    const editor = makeEditor(block)
    const { result } = renderWithContainer(editor)

    act(() => result.current.selectCanvasChoice('embed'))

    expect(editor.updateBlock).toHaveBeenCalledWith(block, {
      type: 'whiteboard',
      props: { canvasId: 'cv1' }
    })
    expect(editor.insertInlineContent).not.toHaveBeenCalled()
  })

  it('Embed leaves the caret on a text line after the board, never on the board', () => {
    // #given the line after the emptied one is a table — not somewhere to type
    const editor = makeEditor(
      { id: 'b1', content: [] },
      { id: 't1', content: { type: 'tableContent', rows: [] } }
    )
    const { result } = renderWithContainer(editor)

    act(() => result.current.selectCanvasChoice('embed'))

    // #then a fresh paragraph goes right after the board and takes the caret
    expect(editor.insertBlocks).toHaveBeenCalledWith([{ type: 'paragraph' }], 'b1', 'after')
    expect(editor.setTextCursorPosition).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'new-paragraph' }),
      'start'
    )
  })

  it('Embed reuses an existing text line after the board for the caret', () => {
    const following = { id: 'p2', content: [{ type: 'text', text: 'After' }] }
    const editor = makeEditor({ id: 'b1', content: [] }, following)
    const { result } = renderWithContainer(editor)

    act(() => result.current.selectCanvasChoice('embed'))

    expect(editor.insertBlocks).not.toHaveBeenCalled()
    expect(editor.setTextCursorPosition).toHaveBeenCalledWith(following, 'start')
  })

  it('Embed keeps a line with other text and puts the board after it', () => {
    const block = { id: 'b1', content: [{ type: 'text', text: 'See ' }] }
    const editor = makeEditor(block)
    const { result } = renderWithContainer(editor)

    act(() => result.current.selectCanvasChoice('embed'))

    expect(editor.updateBlock).not.toHaveBeenCalled()
    expect(editor.insertBlocks).toHaveBeenCalledWith(
      [{ type: 'whiteboard', props: { canvasId: 'cv1' } }],
      block,
      'after'
    )
  })

  it('Embed from inside a table puts the board after the table, never over it', () => {
    const block = { id: 't1', content: { type: 'tableContent', rows: [] } }
    const editor = makeEditor(block)
    const { result } = renderWithContainer(editor)

    act(() => result.current.selectCanvasChoice('embed'))

    expect(editor.updateBlock).not.toHaveBeenCalled()
    expect(editor.insertBlocks).toHaveBeenCalledWith(expect.any(Array), block, 'after')
  })

  it('ArrowDown then Enter picks Embed from the keyboard', () => {
    const editor = makeEditor({ id: 'b1', content: [] })
    const { result, container } = renderWithContainer(editor)

    act(() => {
      fireEvent.keyDown(container, { key: 'ArrowDown' })
    })
    expect(result.current.canvasChoice?.selectedIndex).toBe(1)
    act(() => {
      fireEvent.keyDown(container, { key: 'Enter' })
    })

    expect(editor.updateBlock).toHaveBeenCalledTimes(1)
    expect(result.current.canvasChoice).toBeNull()
  })

  it('Escape keeps the pick as a mention rather than dropping it', () => {
    const editor = makeEditor({ id: 'b1', content: [] })
    const { result, container } = renderWithContainer(editor)

    act(() => {
      fireEvent.keyDown(container, { key: 'ArrowDown' })
    })
    act(() => {
      fireEvent.keyDown(container, { key: 'Escape' })
    })

    expect(editor.insertInlineContent).toHaveBeenCalledWith(wikiLink, { updateSelection: true })
    expect(editor.updateBlock).not.toHaveBeenCalled()
    expect(result.current.canvasChoice).toBeNull()
  })

  it('typing on or clicking away commits the mention exactly once', () => {
    const editor = makeEditor({ id: 'b1', content: [] })
    const { result, container } = renderWithContainer(editor)

    act(() => {
      fireEvent.keyDown(container, { key: 'Shift' })
    })
    expect(result.current.canvasChoice).not.toBeNull()

    act(() => {
      fireEvent.keyDown(container, { key: 'a' })
      fireEvent.mouseDown(document.body)
    })

    expect(editor.insertInlineContent).toHaveBeenCalledTimes(1)
    expect(editor.insertInlineContent).toHaveBeenCalledWith(wikiLink, { updateSelection: true })
    expect(result.current.canvasChoice).toBeNull()
  })
})
