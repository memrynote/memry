import { act, render } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent } from '@testing-library/react'

// Hoist mutable references so factory functions close over the same instances.
const mockOpenTab = vi.fn()
const mockLoadReasons = vi.fn()
const mockClearReasons = vi.fn()
const mockReset = vi.fn()
const mockAddReason = vi.fn()
let mockReasons: unknown[] = []

vi.mock('@/lib/telemetry', () => ({ trackTelemetry: vi.fn() }))

vi.mock('@memry/i18n/renderer', () => ({
  useT: () => ({
    t: (key: string) => key,
    i18n: { resolvedLanguage: 'en', language: 'en', changeLanguage: vi.fn() }
  })
}))

vi.mock('@/contexts/tabs', () => ({
  useTabs: () => ({ openTab: mockOpenTab })
}))

vi.mock('@/services/search-service', () => ({
  searchService: {
    query: vi.fn().mockResolvedValue({ groups: [], totalCount: 0, queryTimeMs: 0 }),
    getReasons: vi.fn().mockImplementation(() => Promise.resolve(mockReasons)),
    addReason: () => mockAddReason(),
    clearReasons: vi.fn().mockResolvedValue({ cleared: true })
  }
}))

vi.mock('./search-filters', () => ({
  SearchFilters: () => <div data-testid="search-filters" />
}))

vi.mock('./recent-reasons', () => ({
  RecentReasons: ({
    reasons,
    onSelect
  }: {
    reasons: { itemId: string; itemTitle: string; itemType: string }[]
    onSelect: (r: { itemId: string; itemTitle: string; itemType: string }) => void
    onClear: () => void
  }) => (
    <div data-testid="recent-reasons">
      {reasons.map((r) => (
        <button key={r.itemId} onClick={() => onSelect(r)}>
          {r.itemTitle}
        </button>
      ))}
    </div>
  )
}))

vi.mock('./search-result-group', () => ({
  SearchResultGroup: ({
    group,
    onSelect
  }: {
    group: {
      type: string
      items: { id: string; title: string; metadata: { type: string } }[]
    }
    query: string
    onSelect: (item: { id: string; title: string; metadata: { type: string } }) => void
  }) => (
    <div data-testid={`result-group-${group.type}`}>
      {group.items.map((item) => (
        <button key={item.id} onClick={() => onSelect(item)}>
          {item.title}
        </button>
      ))}
    </div>
  )
}))

import { trackTelemetry } from '@/lib/telemetry'
import { CommandPalette } from './command-palette'

const trackMock = trackTelemetry as ReturnType<typeof vi.fn>

describe('CommandPalette telemetry', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockReasons = []
    mockLoadReasons.mockReset()
    mockClearReasons.mockReset()
    mockReset.mockReset()
    mockAddReason.mockResolvedValue(undefined)
  })

  it('tracks command_palette_opened when open transitions false → true', async () => {
    const { rerender } = render(<CommandPalette open={false} onOpenChange={vi.fn()} />)

    expect(trackMock).not.toHaveBeenCalledWith('command_palette_opened', expect.anything())

    await act(async () => {
      rerender(<CommandPalette open={true} onOpenChange={vi.fn()} />)
    })

    expect(trackMock).toHaveBeenCalledWith('command_palette_opened', {
      surface: 'search',
      action: 'opened'
    })
  })

  it('does not track command_palette_opened when palette closes', async () => {
    const { rerender } = render(<CommandPalette open={true} onOpenChange={vi.fn()} />)

    // One open event fires on mount with open=true
    let openedCalls = trackMock.mock.calls.filter(([name]) => name === 'command_palette_opened')
    expect(openedCalls).toHaveLength(1)

    // Close — must not add another command_palette_opened call
    await act(async () => {
      rerender(<CommandPalette open={false} onOpenChange={vi.fn()} />)
    })

    openedCalls = trackMock.mock.calls.filter(([name]) => name === 'command_palette_opened')
    expect(openedCalls).toHaveLength(1)
  })

  it('tracks search_result_opened with objectType=note when a note result is opened', async () => {
    const { getByText } = render(<CommandPalette open={true} onOpenChange={vi.fn()} />)

    const { searchService } = await import('@/services/search-service')
    vi.mocked(searchService.query).mockResolvedValue({
      groups: [
        {
          type: 'note' as const,
          items: [
            {
              id: 'note-1',
              title: 'My Note',
              score: 1,
              highlights: [],
              metadata: { type: 'note' as const, emoji: null, path: '/notes/my-note' }
            }
          ]
        }
      ],
      totalCount: 1,
      queryTimeMs: 5
    })

    // Manually trigger handleSelect via the mocked SearchResultGroup's button
    // We need to render with a query so results show — but since query is internal state,
    // we drive it via the Command.Input directly via fireEvent.change
    const input = document.querySelector('[cmdk-input]') as HTMLInputElement
    if (input) {
      await act(async () => {
        fireEvent.change(input, { target: { value: 'my note' } })
      })
    }

    // Wait for debounce (150ms) + async state
    await act(async () => {
      await new Promise((r) => setTimeout(r, 200))
    })

    const noteBtn = getByText('My Note')
    await act(async () => {
      fireEvent.click(noteBtn)
    })

    expect(trackMock).toHaveBeenCalledWith('search_result_opened', {
      surface: 'search',
      action: 'opened',
      objectType: 'note'
    })
  })

  it('tracks search_result_opened with objectType=journal when a journal result is opened', async () => {
    const { getByText } = render(<CommandPalette open={true} onOpenChange={vi.fn()} />)

    const { searchService } = await import('@/services/search-service')
    vi.mocked(searchService.query).mockResolvedValue({
      groups: [
        {
          type: 'journal' as const,
          items: [
            {
              id: 'journal-1',
              title: 'Journal Entry',
              score: 1,
              highlights: [],
              metadata: { type: 'journal' as const, date: '2026-06-10' }
            }
          ]
        }
      ],
      totalCount: 1,
      queryTimeMs: 5
    })

    const input = document.querySelector('[cmdk-input]') as HTMLInputElement
    if (input) {
      await act(async () => {
        fireEvent.change(input, { target: { value: 'journal' } })
      })
    }

    await act(async () => {
      await new Promise((r) => setTimeout(r, 200))
    })

    const btn = getByText('Journal Entry')
    await act(async () => {
      fireEvent.click(btn)
    })

    expect(trackMock).toHaveBeenCalledWith('search_result_opened', {
      surface: 'search',
      action: 'opened',
      objectType: 'journal'
    })
  })

  it('tracks search_result_opened with objectType=task when a task result is opened', async () => {
    const { getByText } = render(<CommandPalette open={true} onOpenChange={vi.fn()} />)

    const { searchService } = await import('@/services/search-service')
    vi.mocked(searchService.query).mockResolvedValue({
      groups: [
        {
          type: 'task' as const,
          items: [
            {
              id: 'task-1',
              title: 'Fix the bug',
              score: 1,
              highlights: [],
              metadata: { type: 'task' as const, projectId: 'proj-1', status: 'todo' as const }
            }
          ]
        }
      ],
      totalCount: 1,
      queryTimeMs: 5
    })

    const input = document.querySelector('[cmdk-input]') as HTMLInputElement
    if (input) {
      await act(async () => {
        fireEvent.change(input, { target: { value: 'fix' } })
      })
    }

    await act(async () => {
      await new Promise((r) => setTimeout(r, 200))
    })

    const btn = getByText('Fix the bug')
    await act(async () => {
      fireEvent.click(btn)
    })

    expect(trackMock).toHaveBeenCalledWith('search_result_opened', {
      surface: 'search',
      action: 'opened',
      objectType: 'task'
    })
  })
})
