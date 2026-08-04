import { fireEvent, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, it, expect, vi, beforeEach, beforeAll } from 'vitest'
import { I18nextProvider } from 'react-i18next'
import type { i18n as I18nInstance } from 'i18next'
import { createRendererI18n } from '@memry/i18n/renderer'
import type { SearchResultItem } from '@memry/contracts/search-api'
import { RelationPicker } from './RelationPicker'

const mocks = vi.hoisted(() => ({
  quick: vi.fn(),
  searchEvents: vi.fn()
}))

vi.mock('@/services/search-service', () => ({
  searchService: { quick: (...args: unknown[]) => mocks.quick(...args) }
}))
vi.mock('@/services/calendar-service', () => ({
  calendarService: { searchEvents: (input: unknown) => mocks.searchEvents(input) }
}))

let i18nEn: I18nInstance

beforeAll(async () => {
  i18nEn = await createRendererI18n({ locale: 'en' })
})

const renderWithI18n = (ui: React.ReactElement) =>
  render(<I18nextProvider i18n={i18nEn}>{ui}</I18nextProvider>)

interface MockHit {
  id: string
  title: string
}

function mockSearch({
  notes = [],
  tasks = [],
  events = []
}: {
  notes?: MockHit[]
  tasks?: MockHit[]
  events?: MockHit[]
}): void {
  const results: SearchResultItem[] = [
    ...notes.map((note) => ({
      id: note.id,
      type: 'note' as const,
      title: note.title,
      snippet: '',
      score: 1,
      normalizedScore: 1,
      matchType: 'fuzzy' as const,
      modifiedAt: '2026-01-01T00:00:00.000Z',
      metadata: { type: 'note' as const, path: `/${note.id}.md`, tags: [] }
    })),
    ...tasks.map((task) => ({
      id: task.id,
      type: 'task' as const,
      title: task.title,
      snippet: '',
      score: 1,
      normalizedScore: 1,
      matchType: 'fuzzy' as const,
      modifiedAt: '2026-01-01T00:00:00.000Z',
      metadata: {
        type: 'task' as const,
        projectId: 'prj_1',
        projectName: 'Inbox',
        projectColor: '#000000',
        statusId: null,
        statusName: null,
        dueDate: null,
        priority: 0,
        completedAt: null
      }
    }))
  ]
  mocks.quick.mockResolvedValue({ results, queryTimeMs: 1 })
  mocks.searchEvents.mockResolvedValue({
    events: events.map((event) => ({
      id: event.id,
      title: event.title,
      startAt: '2026-01-01T00:00:00.000Z',
      endAt: null,
      isAllDay: false
    }))
  })
}

describe('RelationPicker', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('groups results by kind and omits headings for empty groups', async () => {
    mockSearch({
      notes: [{ id: 'nte_1', title: 'Richard Doe' }],
      tasks: [{ id: 'tsk_1', title: 'Call Richard' }],
      events: []
    })
    renderWithI18n(<RelationPicker onSelect={vi.fn()} />)
    await userEvent.type(screen.getByRole('textbox'), 'rich')
    expect(await screen.findByText('NOTES & FILES')).toBeInTheDocument()
    expect(await screen.findByText('TASKS')).toBeInTheDocument()
    expect(screen.queryByText('EVENTS')).not.toBeInTheDocument()
  })

  it('emits a well-formed URI on select', async () => {
    mockSearch({ notes: [{ id: 'nte_1', title: 'Richard Doe' }], tasks: [], events: [] })
    const onSelect = vi.fn()
    renderWithI18n(<RelationPicker onSelect={onSelect} />)
    await userEvent.type(screen.getByRole('textbox'), 'rich')
    await userEvent.click(await screen.findByText('Richard Doe'))
    expect(onSelect).toHaveBeenCalledWith('memry://note/nte_1')
  })

  it('formats task and event URIs with the right kind', async () => {
    mockSearch({
      notes: [],
      tasks: [{ id: 'tsk_1', title: 'Call Richard' }],
      events: [{ id: 'evt_1', title: 'Standup' }]
    })
    const onSelect = vi.fn()
    renderWithI18n(<RelationPicker onSelect={onSelect} />)
    await userEvent.type(screen.getByRole('textbox'), 'r')
    await userEvent.click(await screen.findByText('Call Richard'))
    expect(onSelect).toHaveBeenCalledWith('memry://task/tsk_1')
    await userEvent.click(await screen.findByText('Standup'))
    expect(onSelect).toHaveBeenCalledWith('memry://event/evt_1')
  })

  it('debounces search instead of firing a request per keystroke', async () => {
    mockSearch({ notes: [{ id: 'nte_1', title: 'Richard Doe' }], tasks: [], events: [] })
    renderWithI18n(<RelationPicker onSelect={vi.fn()} />)
    const input = screen.getByRole('textbox')

    vi.useFakeTimers()
    try {
      fireEvent.change(input, { target: { value: 'r' } })
      fireEvent.change(input, { target: { value: 'ri' } })
      fireEvent.change(input, { target: { value: 'ric' } })

      // Just short of the debounce window: no request yet for any keystroke.
      await vi.advanceTimersByTimeAsync(149)
      expect(mocks.quick).not.toHaveBeenCalled()

      // The window elapses: exactly one request, for the final query.
      await vi.advanceTimersByTimeAsync(2)
      expect(mocks.quick).toHaveBeenCalledTimes(1)
      expect(mocks.quick).toHaveBeenCalledWith('ric')
    } finally {
      vi.useRealTimers()
    }
  })

  it('does not query for a blank search', () => {
    mockSearch({ notes: [{ id: 'nte_1', title: 'Richard Doe' }], tasks: [], events: [] })
    renderWithI18n(<RelationPicker onSelect={vi.fn()} />)
    expect(mocks.quick).not.toHaveBeenCalled()
    expect(mocks.searchEvents).not.toHaveBeenCalled()
  })

  it('shows an empty state when a search has no matches anywhere', async () => {
    mockSearch({ notes: [], tasks: [], events: [] })
    renderWithI18n(<RelationPicker onSelect={vi.fn()} />)
    await userEvent.type(screen.getByRole('textbox'), 'nomatch')
    expect(await screen.findByText('No results')).toBeInTheDocument()
  })
})
