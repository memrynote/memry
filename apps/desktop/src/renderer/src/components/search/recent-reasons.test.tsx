import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { Command } from 'cmdk'
import { RecentReasons } from './recent-reasons'
import type { SearchReason } from '@memry/contracts/search-api'

function createReason(overrides: Partial<SearchReason> = {}): SearchReason {
  return {
    id: 'reason-1',
    itemId: 'note-1',
    itemType: 'note',
    itemTitle: 'Turkey Trip Planning',
    itemIcon: null,
    searchQuery: 'turkey visit',
    visitedAt: '2026-03-12T10:00:00.000Z',
    ...overrides
  }
}

// The palette hosts the trail inside cmdk so arrow keys reach it; the tests
// mount the same shell.
function renderReasons(props: {
  reasons: SearchReason[]
  onSelect: (reason: SearchReason) => void
  onClear: () => void
}): ReturnType<typeof render> {
  return render(
    <Command shouldFilter={false} loop>
      <Command.Input autoFocus />
      <Command.List>
        <RecentReasons {...props} />
      </Command.List>
    </Command>
  )
}

describe('RecentReasons', () => {
  const onSelect = vi.fn()
  const onClear = vi.fn()

  beforeEach(() => {
    vi.clearAllMocks()
    // jsdom has no scrollIntoView; cmdk calls it whenever selection moves.
    Element.prototype.scrollIntoView = vi.fn()
  })

  describe('empty state', () => {
    it('shows empty message when no reasons', () => {
      // #when
      renderReasons({ reasons: [], onSelect, onClear })

      // #then
      expect(screen.getByText('Search and click items to build your trail')).toBeInTheDocument()
    })

    it('does not render clear button in empty state', () => {
      // #when
      renderReasons({ reasons: [], onSelect, onClear })

      // #then
      expect(screen.queryByText('Clear')).not.toBeInTheDocument()
    })
  })

  describe('populated state', () => {
    it('renders item title and search query', () => {
      // #given
      const reason = createReason()

      // #when
      renderReasons({ reasons: [reason], onSelect, onClear })

      // #then
      expect(screen.getByText('Turkey Trip Planning')).toBeInTheDocument()
      expect(screen.getByText('turkey visit')).toBeInTheDocument()
    })

    it('renders multiple reasons', () => {
      // #given
      const reasons = [
        createReason({ id: 'r1', itemId: 'note-1', itemTitle: 'Note One' }),
        createReason({ id: 'r2', itemId: 'task-1', itemType: 'task', itemTitle: 'Task One' }),
        createReason({ id: 'r3', itemId: 'j-1', itemType: 'journal', itemTitle: 'Journal Entry' })
      ]

      // #when
      renderReasons({ reasons, onSelect, onClear })

      // #then
      expect(screen.getByText('Note One')).toBeInTheDocument()
      expect(screen.getByText('Task One')).toBeInTheDocument()
      expect(screen.getByText('Journal Entry')).toBeInTheDocument()
    })

    it('renders header with "Reasons" label and clear button', () => {
      // #when
      renderReasons({ reasons: [createReason()], onSelect, onClear })

      // #then
      expect(screen.getByText('Reasons')).toBeInTheDocument()
      expect(screen.getByText('Clear')).toBeInTheDocument()
    })
  })

  describe('interactions', () => {
    it('calls onSelect with the reason when clicked', async () => {
      // #given
      const reason = createReason()
      const user = userEvent.setup()

      renderReasons({ reasons: [reason], onSelect, onClear })

      // #when
      await user.click(screen.getByText('Turkey Trip Planning'))

      // #then
      expect(onSelect).toHaveBeenCalledOnce()
      expect(onSelect).toHaveBeenCalledWith(reason)
    })

    it('calls onClear when clear button clicked', async () => {
      // #given
      const user = userEvent.setup()

      renderReasons({ reasons: [createReason()], onSelect, onClear })

      // #when
      await user.click(screen.getByText('Clear'))

      // #then
      expect(onClear).toHaveBeenCalledOnce()
    })

    it('selects the correct reason from multiple', async () => {
      // #given
      const reasons = [
        createReason({ id: 'r1', itemId: 'n1', itemTitle: 'Alpha' }),
        createReason({ id: 'r2', itemId: 'n2', itemTitle: 'Beta' })
      ]
      const user = userEvent.setup()

      renderReasons({ reasons, onSelect, onClear })

      // #when
      await user.click(screen.getByText('Beta'))

      // #then
      expect(onSelect).toHaveBeenCalledWith(reasons[1])
    })
  })

  describe('keyboard navigation', () => {
    it('registers every reason as a cmdk item', () => {
      // #given
      const reasons = [
        createReason({ id: 'r1', itemTitle: 'Alpha' }),
        createReason({ id: 'r2', itemTitle: 'Beta' })
      ]

      // #when
      const { container } = renderReasons({ reasons, onSelect, onClear })

      // #then
      expect(container.querySelectorAll('[cmdk-item]')).toHaveLength(2)
    })

    it('selects the first reason on mount', () => {
      // #given
      const reasons = [
        createReason({ id: 'r1', itemTitle: 'Alpha' }),
        createReason({ id: 'r2', itemTitle: 'Beta' })
      ]

      // #when
      const { container } = renderReasons({ reasons, onSelect, onClear })

      // #then
      expect(container.querySelector('[cmdk-item][data-selected="true"]')).toHaveTextContent(
        'Alpha'
      )
    })

    it('moves the selection with ArrowDown', async () => {
      // #given
      const reasons = [
        createReason({ id: 'r1', itemTitle: 'Alpha' }),
        createReason({ id: 'r2', itemTitle: 'Beta' })
      ]
      const user = userEvent.setup()
      const { container } = renderReasons({ reasons, onSelect, onClear })

      // #when
      await user.keyboard('{ArrowDown}')

      // #then
      expect(container.querySelector('[cmdk-item][data-selected="true"]')).toHaveTextContent('Beta')
    })

    it('opens the highlighted reason with Enter', async () => {
      // #given
      const reasons = [
        createReason({ id: 'r1', itemTitle: 'Alpha' }),
        createReason({ id: 'r2', itemTitle: 'Beta' })
      ]
      const user = userEvent.setup()
      renderReasons({ reasons, onSelect, onClear })

      // #when
      await user.keyboard('{ArrowDown}{Enter}')

      // #then
      expect(onSelect).toHaveBeenCalledOnce()
      expect(onSelect).toHaveBeenCalledWith(reasons[1])
    })
  })

  describe('type icons', () => {
    it('renders an icon for each content type', () => {
      // #given — one of each type
      const reasons = [
        createReason({ id: 'r1', itemType: 'note', itemTitle: 'A Note' }),
        createReason({ id: 'r2', itemType: 'journal', itemTitle: 'A Journal' }),
        createReason({ id: 'r3', itemType: 'task', itemTitle: 'A Task' }),
        createReason({ id: 'r4', itemType: 'inbox', itemTitle: 'An Inbox' })
      ]

      // #when
      const { container } = renderReasons({ reasons, onSelect, onClear })

      // #then — each reason row has an SVG icon
      const rows = container.querySelectorAll('[cmdk-item]')
      expect(rows).toHaveLength(4)
      rows.forEach((row) => expect(row.querySelector('svg')).toBeInTheDocument())
    })

    it('renders emoji icon instead of SVG when itemIcon is set', () => {
      // #given
      const reason = createReason({ itemIcon: '🏗️' })

      // #when
      renderReasons({ reasons: [reason], onSelect, onClear })

      // #then
      expect(screen.getByText('🏗️')).toBeInTheDocument()
    })

    it('renders SVG fallback icon when itemIcon is null', () => {
      // #given
      const reason = createReason({ itemIcon: null })

      // #when
      const { container } = renderReasons({ reasons: [reason], onSelect, onClear })

      // #then — should have an SVG icon, not an emoji
      const row = container.querySelector('[cmdk-item]')
      expect(row?.querySelector('svg')).toBeInTheDocument()
    })
  })
})
