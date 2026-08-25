import { act, fireEvent, render } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

// Hoist mutable references so factory functions close over the same instances.
const mockOpenTab = vi.fn()
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

vi.mock('@/hooks/use-vault', () => ({
  useVault: () => ({ isIndexing: false, indexBuilt: undefined, indexTotal: undefined })
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

  // Helper: render palette, mock a single result group, type a query, click the result button.
  async function openResultAndClick(
    group: {
      type: string
      items: { id: string; title: string; metadata: Record<string, unknown> }[]
    },
    query: string,
    buttonLabel: string
  ) {
    const { getByText } = render(<CommandPalette open={true} onOpenChange={vi.fn()} />)

    const { searchService } = await import('@/services/search-service')
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    vi.mocked(searchService.query).mockResolvedValue({
      groups: [group] as any,
      totalCount: 1,
      queryTimeMs: 5
    })

    const input = document.querySelector('[cmdk-input]') as HTMLInputElement
    if (input) {
      await act(async () => {
        fireEvent.change(input, { target: { value: query } })
      })
    }

    await act(async () => {
      await new Promise((r) => setTimeout(r, 200))
    })

    await act(async () => {
      fireEvent.click(getByText(buttonLabel))
    })
  }

  it('tracks search_result_opened with objectType=note when a note result is opened', async () => {
    await openResultAndClick(
      {
        type: 'note',
        items: [
          {
            id: 'note-1',
            title: 'My Note',
            metadata: { type: 'note', emoji: null, path: '/notes/my-note' }
          }
        ]
      },
      'my note',
      'My Note'
    )

    expect(trackMock).toHaveBeenCalledWith('search_result_opened', {
      surface: 'search',
      action: 'opened',
      objectType: 'note'
    })
  })

  it('tracks search_result_opened with objectType=journal when a journal result is opened', async () => {
    await openResultAndClick(
      {
        type: 'journal',
        items: [
          {
            id: 'journal-1',
            title: 'Journal Entry',
            metadata: { type: 'journal', date: '2026-06-10' }
          }
        ]
      },
      'journal',
      'Journal Entry'
    )

    expect(trackMock).toHaveBeenCalledWith('search_result_opened', {
      surface: 'search',
      action: 'opened',
      objectType: 'journal'
    })
  })

  it('tracks search_result_opened with objectType=task when a task result is opened', async () => {
    await openResultAndClick(
      {
        type: 'task',
        items: [
          {
            id: 'task-1',
            title: 'Fix the bug',
            metadata: { type: 'task', projectId: 'proj-1', status: 'todo' }
          }
        ]
      },
      'fix',
      'Fix the bug'
    )

    expect(trackMock).toHaveBeenCalledWith('search_result_opened', {
      surface: 'search',
      action: 'opened',
      objectType: 'task'
    })
  })

  it('tracks search_result_opened with objectType=inbox when an inbox result is opened', async () => {
    await openResultAndClick(
      {
        type: 'inbox',
        items: [
          {
            id: 'inbox-1',
            title: 'Saved Link',
            metadata: {
              type: 'inbox',
              itemType: 'link',
              sourceUrl: 'https://example.com',
              sourceTitle: null,
              filedAt: null
            }
          }
        ]
      },
      'saved',
      'Saved Link'
    )

    expect(trackMock).toHaveBeenCalledWith('search_result_opened', {
      surface: 'search',
      action: 'opened',
      objectType: 'inbox'
    })
  })
})
