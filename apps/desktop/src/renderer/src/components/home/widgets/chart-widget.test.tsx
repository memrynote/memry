/**
 * The Home chart widget. Charting itself is PropertyChart's subject and the
 * view block's; what is only true here is the widget config: it is read with
 * the view block's tolerant readers, and the header writes it back whole.
 */
import { fireEvent, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { localDayKey } from '@/lib/property-chart/chart-model'
import type { ReactNode } from 'react'

const mocks = vi.hoisted(() => ({
  getPropertyRows: vi.fn(),
  openSidebarItem: vi.fn(),
  scopes: [] as unknown[],
  notes: [] as unknown[]
}))

vi.mock('@/services/journal-service', () => ({
  journalService: { getPropertyRows: mocks.getPropertyRows }
}))
vi.mock('@/hooks/use-property-definitions', () => ({
  usePropertyDefinitions: () => ({ getDefinition: () => undefined })
}))
vi.mock('@/hooks/use-sidebar-navigation', () => ({
  useSidebarNavigation: () => ({ openSidebarItem: mocks.openSidebarItem })
}))
vi.mock('@/hooks/use-notes-query', () => ({
  useNoteTagsQuery: () => ({ tags: [] }),
  useNoteFoldersQuery: () => ({ folders: [{ path: 'books' }] })
}))
vi.mock('@/hooks/use-folder-view', () => ({
  useFolderView: ({ scope }: { scope: unknown }) => {
    mocks.scopes.push(scope)
    return {
      notes: mocks.notes,
      availableProperties: [{ name: 'rating', type: 'number', usageCount: 3 }],
      hasMore: false,
      unfilteredCount: 0,
      loadMore: vi.fn(),
      isLoading: false,
      error: null
    }
  }
}))

import { ChartWidget, ChartWidgetHeader } from './chart-widget'

function wrap(node: ReactNode): ReactNode {
  return <QueryClientProvider client={new QueryClient()}>{node}</QueryClientProvider>
}

describe('Home chart widget', () => {
  beforeEach(() => {
    mocks.scopes = []
    mocks.notes = []
    mocks.openSidebarItem.mockReset()
    mocks.getPropertyRows.mockReset().mockResolvedValue({
      rows: [],
      properties: [{ name: 'sleep', type: 'number', count: 1 }]
    })
  })

  it('reads the journal when the source is missing or unreadable, and never the vault', async () => {
    render(wrap(<ChartWidget config={{ source: { kind: 'later' } }} size="M" />))

    expect(await screen.findByText('Choose what to plot')).toBeInTheDocument()
    expect(mocks.getPropertyRows).toHaveBeenCalled()
    expect(mocks.scopes).toEqual([])
  })

  it('starts the chart over when the source changes, keeping other config keys', async () => {
    // #given a journal sleep chart with a key a newer build wrote
    const onChange = vi.fn()
    render(
      wrap(
        <ChartWidgetHeader
          config={{ source: { kind: 'journal' }, chart: { property: 'sleep' }, pinned: true }}
          onChange={onChange}
        />
      )
    )

    // #when the source moves to a folder
    await userEvent.click(screen.getByTestId('chart-settings-trigger'))
    await userEvent.click(screen.getByTestId('view-block-source'))
    await userEvent.hover(await screen.findByRole('menuitem', { name: 'Folder' }))
    await userEvent.click(await screen.findByRole('menuitem', { name: 'books' }))

    // #then the old property, which belonged to the journal, is dropped
    expect(onChange).toHaveBeenCalledWith({
      source: { kind: 'folder', path: 'books' },
      chart: {},
      pinned: true
    })
  })

  describe('over a folder', () => {
    beforeEach(() => {
      vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(640)
    })
    afterEach(() => {
      vi.restoreAllMocks()
    })

    it('places notes on the day Date from names, and opens the note on that day', () => {
      // #given a book finished today, created long ago
      const today = localDayKey(new Date())
      mocks.notes = [
        {
          id: 'dune',
          path: 'books/Dune.md',
          title: 'Dune',
          emoji: null,
          folder: 'books',
          tags: [],
          created: '2020-01-01T12:00:00.000Z',
          modified: '2020-01-01T12:00:00.000Z',
          wordCount: 0,
          properties: { rating: 5, finished: today }
        }
      ]

      render(
        wrap(
          <ChartWidget
            config={{
              source: { kind: 'folder', path: 'books' },
              chart: { property: 'rating', type: 'bar', rangeDays: 7, dateFrom: 'finished' }
            }}
            size="M"
          />
        )
      )

      // #then the rating lands on today, not on the day the note was created
      const chart = screen.getByRole('img', { name: 'rating over the last 7 days' })
      expect(mocks.scopes[0]).toEqual({ kind: 'folder', path: 'books' })
      expect(chart.querySelectorAll('rect')).toHaveLength(1)

      fireEvent.pointerMove(chart, { clientX: 630 })
      fireEvent.click(chart)
      expect(mocks.openSidebarItem).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'note', entityId: 'dune', path: 'books/Dune.md' }),
        undefined
      )
    })
  })
})
