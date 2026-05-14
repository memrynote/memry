import type { ComponentProps } from 'react'

import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { RefPicker } from '../ref-picker'

const mockSearchQuery = vi.fn()
const mockCalendarListEvents = vi.fn()

function renderRefPicker(overrides: Partial<ComponentProps<typeof RefPicker>> = {}) {
  const props: ComponentProps<typeof RefPicker> = {
    query: 'star',
    selectedIndex: 0,
    onItemsChange: vi.fn(),
    onPick: vi.fn(),
    onSelectedIndexChange: vi.fn(),
    onClose: vi.fn(),
    ...overrides
  }

  render(<RefPicker {...props} />)
  return props
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
})
