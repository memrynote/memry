import { act, renderHook } from '@testing-library/react'
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest'
import { useMentionSuggestions } from './use-mention-suggestions'
import type { MentionSuggestionItem } from '../mention-menu'

const mocks = vi.hoisted(() => ({
  listNotes: vi.fn(),
  logger: { error: vi.fn() }
}))

vi.mock('@/services/notes-service', () => ({
  notesService: {
    list: (...args: unknown[]) => mocks.listNotes(...args)
  }
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

describe('useMentionSuggestions', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-05-10T12:00:00.000Z'))
    mocks.listNotes.mockResolvedValue({ notes: makeNotes(3) })
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('puts the Date group (date + remind) first then notes on an empty query', async () => {
    const editor = { insertInlineContent: vi.fn() }
    const { result } = renderHook(() => useMentionSuggestions(editor, { onInsertDate: vi.fn() }))

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
    const { result } = renderHook(() => useMentionSuggestions(editor, { onInsertDate: vi.fn() }))

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
    const { result } = renderHook(() => useMentionSuggestions(editor, { onInsertDate: vi.fn() }))

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
    const { result } = renderHook(() => useMentionSuggestions(editor, { onInsertDate: vi.fn() }))

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
    const { result } = renderHook(() => useMentionSuggestions(editor, { onInsertDate }))

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
    const { result } = renderHook(() => useMentionSuggestions(editor, { onInsertDate: vi.fn() }))

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
    const { result } = renderHook(() => useMentionSuggestions(editor, { onInsertDate: vi.fn() }))

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
    const { result } = renderHook(() => useMentionSuggestions(editor, { onInsertDate: vi.fn() }))

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
    const { result } = renderHook(() => useMentionSuggestions(editor, { onInsertDate }))

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
