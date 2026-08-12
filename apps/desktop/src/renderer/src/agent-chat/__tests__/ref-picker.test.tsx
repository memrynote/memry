import type { ComponentProps } from 'react'

import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { RefPicker } from '../ref-picker'

const mockSearchQuery = vi.fn()
const mockCalendarListEvents = vi.fn()

/** Comfortably past the picker's 150 ms search debounce. */
const SETTLE_MS = 200

function baseProps(query: string): ComponentProps<typeof RefPicker> {
  return {
    query,
    selectedIndex: 0,
    anchorRef: { current: document.createElement('div') },
    onItemsChange: vi.fn(),
    onPick: vi.fn(),
    onSelectedIndexChange: vi.fn(),
    onClose: vi.fn()
  }
}

function renderRefPicker(overrides: Partial<ComponentProps<typeof RefPicker>> = {}) {
  const props: ComponentProps<typeof RefPicker> = { ...baseProps('star'), ...overrides }

  render(<RefPicker {...props} />)
  return props
}

/** Renders the picker and hands back a "type another character" helper. */
function renderTypeablePicker(query: string) {
  const props = baseProps(query)
  const { rerender, unmount } = render(<RefPicker {...props} />)
  return {
    props,
    unmount,
    retype: (next: string) => rerender(<RefPicker {...props} query={next} />)
  }
}

function noteResponse(id: string, title: string) {
  return {
    groups: [
      {
        type: 'note',
        totalInGroup: 1,
        results: [
          {
            id,
            type: 'note',
            title,
            snippet: '',
            score: 1,
            normalizedScore: 1,
            matchType: 'title',
            modifiedAt: '2026-05-10T00:00:00.000Z',
            metadata: { type: 'note', path: `/${title}`, tags: [], emoji: null }
          }
        ]
      }
    ],
    totalCount: 1,
    queryTimeMs: 1
  }
}

describe('RefPicker', () => {
  beforeEach(() => {
    mockSearchQuery.mockReset()
    mockSearchQuery.mockResolvedValue({
      groups: [],
      totalCount: 0,
      queryTimeMs: 0
    })
    mockCalendarListEvents.mockReset()
    mockCalendarListEvents.mockResolvedValue({ events: [] })
    vi.mocked(window.api.search.query).mockImplementation(mockSearchQuery)
    Object.assign(window.api, {
      calendar: {
        ...((window.api as unknown as { calendar?: Record<string, unknown> }).calendar ?? {}),
        listEvents: mockCalendarListEvents
      }
    })
  })

  it('falls back to an empty picker when search and calendar sources fail', async () => {
    mockSearchQuery.mockRejectedValue(new Error('search failed'))
    mockCalendarListEvents.mockRejectedValue(new Error('calendar failed'))
    const props = renderRefPicker({ query: 'missing', selectedIndex: -1 })

    await waitFor(() => {
      expect(props.onItemsChange).toHaveBeenLastCalledWith([])
    })

    fireEvent.keyDown(screen.getByRole('listbox'), { key: 'Escape' })

    expect(props.onSelectedIndexChange).toHaveBeenLastCalledWith(-1)
    expect(props.onClose).toHaveBeenCalledTimes(1)
  })

  it('renders the list in a body-level fixed portal so overflow cannot clip it', async () => {
    renderRefPicker()

    const listbox = await screen.findByRole('listbox')
    // Portalled directly under document.body, not nested in the render container.
    expect(listbox.parentElement).toBe(document.body)
    expect(listbox.getAttribute('data-ref-picker')).toBe('')
    expect(listbox.style.position).toBe('fixed')
  })

  it('selects, hovers, and picks icon-backed search and calendar results', async () => {
    mockSearchQuery.mockResolvedValue({
      groups: [
        {
          type: 'note',
          totalInGroup: 1,
          results: [
            {
              id: 'note-1',
              type: 'note',
              title: 'Star Wars Movies',
              snippet: '',
              score: 1,
              normalizedScore: 1,
              matchType: 'title',
              modifiedAt: '2026-05-10T00:00:00.000Z',
              metadata: { type: 'note', path: '/Star Wars Movies', tags: [], emoji: '🎬' }
            }
          ]
        }
      ],
      totalCount: 1,
      queryTimeMs: 1
    })
    mockCalendarListEvents.mockResolvedValue({
      events: [
        {
          id: 'event-1',
          title: 'Watch Star Wars',
          description: 'Movie night',
          location: 'Home theater',
          startAt: '2026-05-14T20:00:00.000Z',
          endAt: '2026-05-14T22:00:00.000Z',
          allDay: false,
          archivedAt: null,
          createdAt: '2026-05-10T00:00:00.000Z',
          updatedAt: '2026-05-10T00:00:00.000Z'
        }
      ]
    })
    const props = renderRefPicker()

    const noteOption = (await screen.findByText('Star Wars Movies')).closest(
      'button'
    ) as HTMLButtonElement
    const calendarOption = (await screen.findByText('Watch Star Wars')).closest(
      'button'
    ) as HTMLButtonElement

    expect(noteOption).toHaveAttribute('aria-selected', 'true')
    expect(props.onItemsChange).toHaveBeenLastCalledWith([
      {
        kind: 'note',
        ref_id: 'note-1',
        label: 'Star Wars Movies',
        icon: { kind: 'note', emoji: '🎬' }
      },
      {
        kind: 'calendar_event',
        ref_id: 'event-1',
        label: 'Watch Star Wars',
        icon: { kind: 'calendar_event' }
      }
    ])

    fireEvent.mouseEnter(calendarOption)
    fireEvent.click(calendarOption)

    expect(props.onSelectedIndexChange).toHaveBeenLastCalledWith(1)
    expect(props.onPick).toHaveBeenCalledWith({
      kind: 'calendar_event',
      ref_id: 'event-1',
      label: 'Watch Star Wars',
      icon: { kind: 'calendar_event' }
    })
  })

  it('maps task, journal, inbox, and location-matched calendar results to mention items', async () => {
    mockSearchQuery.mockResolvedValue({
      groups: [
        {
          type: 'task',
          totalInGroup: 1,
          results: [
            {
              id: 'task-1',
              type: 'task',
              title: 'Review Star Wars notes',
              snippet: '',
              score: 1,
              normalizedScore: 1,
              matchType: 'title',
              modifiedAt: '2026-05-10T00:00:00.000Z',
              metadata: {
                type: 'task',
                projectId: 'project-1',
                projectName: 'Inbox',
                projectColor: '#22c55e',
                statusId: null,
                statusName: null,
                dueDate: null,
                priority: 0,
                completedAt: null
              }
            }
          ]
        },
        {
          type: 'journal',
          totalInGroup: 1,
          results: [
            {
              id: 'journal-1',
              type: 'journal',
              title: 'Star Wars journal',
              snippet: '',
              score: 1,
              normalizedScore: 1,
              matchType: 'title',
              modifiedAt: '2026-05-10T00:00:00.000Z',
              metadata: {
                type: 'journal',
                date: '2026-05-10',
                path: '/Journal/2026-05-10',
                tags: []
              }
            }
          ]
        },
        {
          type: 'inbox',
          totalInGroup: 1,
          results: [
            {
              id: 'inbox-1',
              type: 'inbox',
              title: 'Star Wars trailer',
              snippet: '',
              score: 1,
              normalizedScore: 1,
              matchType: 'title',
              modifiedAt: '2026-05-10T00:00:00.000Z',
              metadata: {
                type: 'inbox',
                itemType: 'video',
                sourceUrl: null,
                sourceTitle: null,
                filedAt: null
              }
            }
          ]
        }
      ],
      totalCount: 3,
      queryTimeMs: 1
    })
    mockCalendarListEvents.mockResolvedValue({
      events: [
        {
          id: 'event-location',
          title: 'Movie planning',
          description: null,
          location: 'Star Wars room',
          startAt: '2026-05-14T20:00:00.000Z',
          endAt: '2026-05-14T22:00:00.000Z',
          allDay: false,
          archivedAt: null,
          createdAt: '2026-05-10T00:00:00.000Z',
          updatedAt: '2026-05-10T00:00:00.000Z'
        }
      ]
    })
    const props = renderRefPicker()

    await screen.findByText('Review Star Wars notes')

    expect(screen.getByText('Star Wars journal')).toBeInTheDocument()
    expect(screen.getByText('Star Wars trailer')).toBeInTheDocument()
    expect(screen.getByText('Movie planning')).toBeInTheDocument()
    expect(props.onItemsChange).toHaveBeenLastCalledWith([
      {
        kind: 'task',
        ref_id: 'task-1',
        label: 'Review Star Wars notes',
        icon: { kind: 'task' }
      },
      {
        kind: 'journal',
        ref_id: 'journal-1',
        label: 'Star Wars journal',
        icon: { kind: 'journal' }
      },
      {
        kind: 'inbox',
        ref_id: 'inbox-1',
        label: 'Star Wars trailer',
        icon: { kind: 'inbox', itemType: 'video' }
      },
      {
        kind: 'calendar_event',
        ref_id: 'event-location',
        label: 'Movie planning',
        icon: { kind: 'calendar_event' }
      }
    ])
  })

  it('debounces mention searches so a burst of keystrokes costs one round-trip', async () => {
    vi.useFakeTimers()
    try {
      const { retype } = renderTypeablePicker('s')
      await act(async () => {
        await vi.advanceTimersByTimeAsync(SETTLE_MS)
      })

      mockSearchQuery.mockClear()
      mockCalendarListEvents.mockClear()

      const keystrokes = ['st', 'sta', 'star', 'starw', 'starwa', 'starwar', 'starwars']
      for (const query of keystrokes) {
        retype(query)
        await act(async () => {
          await vi.advanceTimersByTimeAsync(20)
        })
      }

      // Undebounced these 7 keystrokes cost 7 FTS queries + 7 calendar queries.
      expect(mockSearchQuery).not.toHaveBeenCalled()
      expect(mockCalendarListEvents).not.toHaveBeenCalled()

      await act(async () => {
        await vi.advanceTimersByTimeAsync(SETTLE_MS)
      })

      expect(mockSearchQuery).toHaveBeenCalledTimes(1)
      expect(mockCalendarListEvents).toHaveBeenCalledTimes(1)
      expect(mockSearchQuery).toHaveBeenCalledWith({ text: 'starwars', limit: 20 })
    } finally {
      vi.useRealTimers()
    }
  })

  it('keeps the newest query and discards a stale search that resolves late', async () => {
    vi.useFakeTimers()
    try {
      const resolvers = new Map<string, (value: unknown) => void>()
      mockSearchQuery.mockImplementation(
        (args: { text: string }) =>
          new Promise((resolve) => {
            resolvers.set(args.text, resolve)
          })
      )

      const { props, retype } = renderTypeablePicker('old')
      await act(async () => {
        await vi.advanceTimersByTimeAsync(SETTLE_MS)
      })

      retype('new')
      await act(async () => {
        await vi.advanceTimersByTimeAsync(SETTLE_MS)
      })

      expect([...resolvers.keys()]).toEqual(['old', 'new'])

      // The newer search answers first, then the stale one lands behind it.
      await act(async () => {
        resolvers.get('new')?.(noteResponse('note-new', 'Newest note'))
        await vi.advanceTimersByTimeAsync(0)
      })
      await act(async () => {
        resolvers.get('old')?.(noteResponse('note-old', 'Stale note'))
        await vi.advanceTimersByTimeAsync(0)
      })

      expect(screen.getByText('Newest note')).toBeInTheDocument()
      expect(screen.queryByText('Stale note')).not.toBeInTheDocument()
      expect(props.onItemsChange).toHaveBeenLastCalledWith([
        {
          kind: 'note',
          ref_id: 'note-new',
          label: 'Newest note',
          icon: { kind: 'note', emoji: null }
        }
      ])
    } finally {
      vi.useRealTimers()
    }
  })

  it('clears the pending search timer when the picker closes', async () => {
    vi.useFakeTimers()
    try {
      const { retype, unmount } = renderTypeablePicker('a')
      await act(async () => {
        await vi.advanceTimersByTimeAsync(SETTLE_MS)
      })

      mockSearchQuery.mockClear()
      mockCalendarListEvents.mockClear()
      retype('ab')

      // Closing the picker mid-debounce must not leave a timer behind that
      // still fires a search after the component is gone.
      unmount()
      await act(async () => {
        await vi.advanceTimersByTimeAsync(SETTLE_MS * 5)
      })

      expect(mockSearchQuery).not.toHaveBeenCalled()
      expect(mockCalendarListEvents).not.toHaveBeenCalled()
    } finally {
      vi.useRealTimers()
    }
  })
})
