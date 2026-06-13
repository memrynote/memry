import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { MentionMenu, type MentionSuggestionItem } from './mention-menu'

vi.mock('@memry/i18n/renderer', () => ({
  useT: () => ({
    t: (key: string) => {
      const messages: Record<string, string> = {
        'menus.mention.date': 'Date',
        'menus.mention.remindMe': 'Remind me',
        'menus.mention.dateHint': 'Keep typing a date…',
        'menus.mention.showMore': 'Show more',
        'menus.mention.loading': 'Loading notes...',
        'menus.mention.empty': 'No notes found',
        'menus.mention.aria': 'Date and note suggestions'
      }
      return messages[key] ?? key
    }
  })
}))

const value = {
  dateISO: '2026-06-21T09:00:00.000Z',
  hasTime: false,
  dateFormat: 'relative' as const,
  remind: 'none' as const,
  timeFormat: 'system' as const
}

const dateItem: MentionSuggestionItem = { kind: 'date', label: 'Next Sunday', value }
const remindItem: MentionSuggestionItem = {
  kind: 'remind',
  subtitle: '21 June 2026',
  value: { ...value, remind: 'at' }
}
const noteA: MentionSuggestionItem = { kind: 'note', id: 'n1', title: 'Q3 Roadmap' }
const noteB: MentionSuggestionItem = { kind: 'note', id: 'n2', title: 'Meeting prep' }

function renderMenu(props: Partial<React.ComponentProps<typeof MentionMenu>> = {}) {
  const onItemClick = vi.fn()
  const onShowMore = vi.fn()
  render(
    <MentionMenu
      items={[dateItem, remindItem, noteA, noteB]}
      loadingState="loaded"
      selectedIndex={0}
      onItemClick={onItemClick}
      hasMore={false}
      onShowMore={onShowMore}
      {...props}
    />
  )
  return { onItemClick, onShowMore }
}

describe('MentionMenu', () => {
  it('renders the Date group, Remind row with subtitle, divider, and notes', () => {
    renderMenu()
    expect(screen.getByText('Date')).toBeInTheDocument()
    expect(screen.getByText('Next Sunday')).toBeInTheDocument()
    expect(screen.getByText('Remind me')).toBeInTheDocument()
    expect(screen.getByText('— 21 June 2026')).toBeInTheDocument()
    expect(screen.getByText('Q3 Roadmap')).toBeInTheDocument()
    expect(screen.getByRole('separator')).toBeInTheDocument()
  })

  it('renders a non-selectable hint row for a date-hint item', () => {
    const onItemClick = vi.fn()
    render(
      <MentionMenu
        items={[{ kind: 'date-hint' }]}
        loadingState="loaded"
        selectedIndex={0}
        onItemClick={onItemClick}
        hasMore={false}
        onShowMore={vi.fn()}
      />
    )
    expect(screen.getByText('Keep typing a date…')).toBeInTheDocument()
    // The hint is informational only — never an option, never the "Date" group.
    expect(screen.queryByRole('option')).not.toBeInTheDocument()
    expect(screen.queryByText('Date')).not.toBeInTheDocument()
  })

  it('renders no Date group and no divider when items are notes only', () => {
    renderMenu({ items: [noteA, noteB] })
    expect(screen.queryByText('Date')).not.toBeInTheDocument()
    expect(screen.queryByText('Remind me')).not.toBeInTheDocument()
    expect(screen.queryByRole('separator')).not.toBeInTheDocument()
  })

  it('shows "Show more" only when hasMore, and clicking it fires onShowMore (not onItemClick)', () => {
    const { rerender } = render(
      <MentionMenu
        items={[noteA, noteB]}
        loadingState="loaded"
        selectedIndex={0}
        onItemClick={vi.fn()}
        hasMore={false}
        onShowMore={vi.fn()}
      />
    )
    expect(screen.queryByText('Show more')).not.toBeInTheDocument()

    const onItemClick = vi.fn()
    const onShowMore = vi.fn()
    rerender(
      <MentionMenu
        items={[noteA, noteB]}
        loadingState="loaded"
        selectedIndex={0}
        onItemClick={onItemClick}
        hasMore={true}
        onShowMore={onShowMore}
      />
    )
    fireEvent.click(screen.getByText('Show more'))
    expect(onShowMore).toHaveBeenCalledTimes(1)
    expect(onItemClick).not.toHaveBeenCalled()
  })

  it('calls onItemClick with the clicked note item', () => {
    const { onItemClick } = renderMenu()
    fireEvent.click(screen.getByText('Q3 Roadmap'))
    expect(onItemClick).toHaveBeenCalledWith(noteA)
  })

  it('calls onItemClick with the date and remind items', () => {
    const { onItemClick } = renderMenu()
    fireEvent.click(screen.getByText('Next Sunday'))
    expect(onItemClick).toHaveBeenCalledWith(dateItem)
    fireEvent.click(screen.getByText('Remind me'))
    expect(onItemClick).toHaveBeenCalledWith(remindItem)
  })
})
