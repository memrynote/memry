/**
 * InboxList Component Tests (T519-T520)
 *
 * Tests for InboxList components with card display for all item types.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { InboxListSection, InboxListItem, TypeIcon, TranscriptionStatus } from './inbox-list'
import type { InboxItemListItem, InboxItemType } from '@/types'

// ============================================================================
// Test Data
// ============================================================================

const createInboxItem = (
  type: InboxItemType,
  overrides: Partial<InboxItemListItem> = {}
): InboxItemListItem => ({
  id: `item-${Date.now()}-${Math.random()}`,
  type,
  title: 'Test Item',
  rawContent: 'Test content',
  createdAt: new Date(),
  status: 'pending' as const,
  viewedAt: undefined,
  snoozedUntil: null,
  archivedAt: null,
  metadata: null,
  thumbnailUrl: null,
  transcription: null,
  transcriptionStatus: null,
  duration: null,
  attachments: [],
  ...overrides
})

const defaultSectionProps = {
  title: 'Today',
  selectedIds: new Set<string>(),
  focusedId: null,
  onSelect: vi.fn(),
  onFocus: vi.fn()
}

// Wrapper to provide context for InboxListItem
function renderWithContext(item: InboxItemListItem, overrides = {}) {
  return render(
    <InboxListSection {...defaultSectionProps}>
      <InboxListItem
        item={item}
        period="TODAY"
        onPreview={vi.fn()}
        onArchive={vi.fn()}
        {...overrides}
      />
    </InboxListSection>
  )
}

// ============================================================================
// T519: InboxListItem - Item Type Display Tests
// ============================================================================

describe('T519: InboxListItem - item type display', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  describe('TypeIcon', () => {
    it('should render link icon for link type', () => {
      render(<TypeIcon type="link" />)

      // Icon should be rendered (SVG with aria-hidden)
      expect(document.querySelector('svg[aria-hidden="true"]')).toBeInTheDocument()
    })

    it('should render file icon for note type', () => {
      render(<TypeIcon type="note" />)

      expect(document.querySelector('[aria-hidden="true"]')).toBeInTheDocument()
    })

    it('should render image icon for image type', () => {
      render(<TypeIcon type="image" />)

      expect(document.querySelector('[aria-hidden="true"]')).toBeInTheDocument()
    })

    it('should render mic icon for voice type', () => {
      render(<TypeIcon type="voice" />)

      expect(document.querySelector('[aria-hidden="true"]')).toBeInTheDocument()
    })

    it('should render scissors icon for clip type', () => {
      render(<TypeIcon type="clip" />)

      expect(document.querySelector('[aria-hidden="true"]')).toBeInTheDocument()
    })

    it('should render file icon for pdf type', () => {
      render(<TypeIcon type="pdf" />)

      expect(document.querySelector('[aria-hidden="true"]')).toBeInTheDocument()
    })

    it('should render share icon for social type', () => {
      render(<TypeIcon type="social" />)

      expect(document.querySelector('[aria-hidden="true"]')).toBeInTheDocument()
    })

    it('should render bell icon for unviewed reminder', () => {
      render(<TypeIcon type="reminder" isViewed={false} />)

      expect(document.querySelector('[aria-hidden="true"]')).toBeInTheDocument()
    })

    it('should render check icon for viewed reminder', () => {
      render(<TypeIcon type="reminder" isViewed={true} />)

      expect(document.querySelector('[aria-hidden="true"]')).toBeInTheDocument()
    })
  })

  describe('link item', () => {
    it('should display link item with title', () => {
      const item = createInboxItem('link', { title: 'Interesting Article' })
      renderWithContext(item)

      expect(screen.getByText('Interesting Article')).toBeInTheDocument()
    })
  })

  describe('note item', () => {
    it('should display note item with title', () => {
      const item = createInboxItem('note', { title: 'Quick note' })
      renderWithContext(item)

      expect(screen.getByText('Quick note')).toBeInTheDocument()
    })
  })

  describe('image item', () => {
    it('should display image item with thumbnail', () => {
      const item = createInboxItem('image', {
        title: 'Screenshot',
        thumbnailUrl: 'https://example.com/thumb.jpg'
      })
      renderWithContext(item)

      expect(screen.getByText('Screenshot')).toBeInTheDocument()
      // Image has alt="" making it presentational, so we query by tag
      expect(document.querySelector('img')).toBeInTheDocument()
    })

    it('should handle missing thumbnail gracefully', () => {
      const item = createInboxItem('image', {
        title: 'Screenshot',
        thumbnailUrl: null
      })
      renderWithContext(item)

      expect(screen.getByText('Screenshot')).toBeInTheDocument()
    })
  })

  describe('voice item', () => {
    it('should display voice item with duration', () => {
      const item = createInboxItem('voice', {
        title: 'Voice memo',
        duration: 65
      })
      renderWithContext(item)

      // Should show title with duration
      expect(screen.getByText(/Voice memo/)).toBeInTheDocument()
      expect(screen.getByText(/1:05/)).toBeInTheDocument()
    })

    it('should show transcription status when transcribing', () => {
      const item = createInboxItem('voice', {
        title: 'Voice memo',
        transcriptionStatus: 'processing'
      })
      renderWithContext(item)

      expect(screen.getByText(/transcribing/i)).toBeInTheDocument()
    })

    it('should show transcription when complete', () => {
      const item = createInboxItem('voice', {
        title: 'Voice memo',
        transcriptionStatus: 'complete',
        transcription: 'This is the transcribed text'
      })
      renderWithContext(item)

      expect(screen.getByText(/This is the transcribed text/)).toBeInTheDocument()
    })

    it('should show retry button on transcription failure', () => {
      const onRetry = vi.fn()
      const item = createInboxItem('voice', {
        id: 'voice-1',
        title: 'Voice memo',
        transcriptionStatus: 'failed'
      })
      renderWithContext(item, { onRetryTranscription: onRetry })

      expect(screen.getByText(/transcription failed/i)).toBeInTheDocument()
      expect(screen.getByRole('button', { name: /retry/i })).toBeInTheDocument()
    })
  })

  describe('clip item', () => {
    it('should display clip item with title', () => {
      const item = createInboxItem('clip', { title: 'Code snippet' })
      renderWithContext(item)

      expect(screen.getByText('Code snippet')).toBeInTheDocument()
    })
  })

  describe('pdf item', () => {
    it('should display pdf item with title', () => {
      const item = createInboxItem('pdf', { title: 'Document.pdf' })
      renderWithContext(item)

      expect(screen.getByText('Document.pdf')).toBeInTheDocument()
    })
  })

  describe('social item', () => {
    it('should display social item with title', () => {
      const item = createInboxItem('social', { title: '@user on Twitter' })
      renderWithContext(item)

      expect(screen.getByText('@user on Twitter')).toBeInTheDocument()
    })
  })

  describe('reminder item', () => {
    it('should display reminder with target title', () => {
      const item = createInboxItem('reminder', {
        title: 'Reminder',
        metadata: { targetTitle: 'Meeting Notes', targetId: 'note-1', targetType: 'note' }
      })
      renderWithContext(item)

      expect(screen.getByText('Meeting Notes')).toBeInTheDocument()
    })

    it('should show reminder badge', () => {
      const item = createInboxItem('reminder', {
        title: 'Reminder',
        metadata: { targetTitle: 'Meeting Notes', targetId: 'note-1', targetType: 'note' }
      })
      renderWithContext(item)

      expect(screen.getByText('Reminder')).toBeInTheDocument()
    })

    it('should show viewed badge for viewed reminders', () => {
      const item = createInboxItem('reminder', {
        title: 'Reminder',
        viewedAt: new Date(),
        metadata: { targetTitle: 'Meeting Notes', targetId: 'note-1', targetType: 'note' }
      })
      renderWithContext(item)

      expect(screen.getByText('Viewed')).toBeInTheDocument()
    })
  })
})

// ============================================================================
// T520: InboxListItem - Selection and Actions Tests
// ============================================================================

describe('T520: InboxListItem - selection and actions', () => {
  const onSelect = vi.fn()
  const onFocus = vi.fn()
  const onPreview = vi.fn()
  const onArchive = vi.fn()

  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('should call onPreview when item is clicked', async () => {
    const user = userEvent.setup()
    const item = createInboxItem('note', { id: 'item-1', title: 'Test' })

    render(
      <InboxListSection {...defaultSectionProps} onSelect={onSelect} onFocus={onFocus}>
        <InboxListItem
          item={item}
          period="today"
          onPreview={onPreview}
          onArchive={onArchive}
        />
      </InboxListSection>
    )

    await user.click(screen.getByText('Test'))

    expect(onFocus).toHaveBeenCalledWith('item-1')
    expect(onPreview).toHaveBeenCalledWith('item-1')
  })

  it('should toggle selection when checkbox is clicked', async () => {
    const user = userEvent.setup()
    const item = createInboxItem('note', { id: 'item-1', title: 'Test' })

    render(
      <InboxListSection {...defaultSectionProps} onSelect={onSelect} onFocus={onFocus}>
        <InboxListItem
          item={item}
          period="today"
          onPreview={onPreview}
          onArchive={onArchive}
        />
      </InboxListSection>
    )

    const checkbox = screen.getByRole('checkbox', { name: /select/i })
    await user.click(checkbox)

    expect(onSelect).toHaveBeenCalledWith('item-1', false)
  })

  it('should support shift-click for range selection', async () => {
    const user = userEvent.setup()
    const item = createInboxItem('note', { id: 'item-1', title: 'Test' })

    render(
      <InboxListSection {...defaultSectionProps} onSelect={onSelect} onFocus={onFocus}>
        <InboxListItem
          item={item}
          period="today"
          onPreview={onPreview}
          onArchive={onArchive}
        />
      </InboxListSection>
    )

    const checkbox = screen.getByRole('checkbox', { name: /select/i })
    await user.keyboard('{Shift>}')
    await user.click(checkbox)
    await user.keyboard('{/Shift}')

    expect(onSelect).toHaveBeenCalledWith('item-1', true)
  })

  it('should show selected styling when selected', () => {
    const item = createInboxItem('note', { id: 'item-1', title: 'Test' })
    const selectedIds = new Set(['item-1'])

    render(
      <InboxListSection {...defaultSectionProps} selectedIds={selectedIds}>
        <InboxListItem
          item={item}
          period="today"
          onPreview={onPreview}
          onArchive={onArchive}
        />
      </InboxListSection>
    )

    const checkbox = screen.getByRole('checkbox', { name: /select/i })
    expect(checkbox).toBeChecked()
  })

  it('should show focus styling when focused', () => {
    const item = createInboxItem('note', { id: 'item-1', title: 'Test' })

    render(
      <InboxListSection {...defaultSectionProps} focusedId="item-1">
        <InboxListItem
          item={item}
          period="today"
          onPreview={onPreview}
          onArchive={onArchive}
        />
      </InboxListSection>
    )

    const listItem = screen.getByRole('listitem')
    expect(listItem).toHaveAttribute('tabindex', '0')
  })

  it('should have proper aria-selected state', () => {
    const item = createInboxItem('note', { id: 'item-1', title: 'Test' })
    const selectedIds = new Set(['item-1'])

    render(
      <InboxListSection {...defaultSectionProps} selectedIds={selectedIds}>
        <InboxListItem
          item={item}
          period="today"
          onPreview={onPreview}
          onArchive={onArchive}
        />
      </InboxListSection>
    )

    const listItem = screen.getByRole('listitem')
    expect(listItem).toHaveAttribute('aria-selected', 'true')
  })

  it('should have proper aria-label with type and title', () => {
    const item = createInboxItem('link', { title: 'Article' })

    render(
      <InboxListSection {...defaultSectionProps}>
        <InboxListItem
          item={item}
          period="today"
          onPreview={onPreview}
          onArchive={onArchive}
        />
      </InboxListSection>
    )

    const listItem = screen.getByRole('listitem')
    expect(listItem).toHaveAttribute('aria-label', 'link: Article')
  })
})

// ============================================================================
// InboxListSection - Section Tests
// ============================================================================

describe('InboxListSection', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('should render section with title', () => {
    render(
      <InboxListSection {...defaultSectionProps}>
        <div>Content</div>
      </InboxListSection>
    )

    expect(screen.getByText('Today')).toBeInTheDocument()
  })

  it('should render section with count badge', () => {
    render(
      <InboxListSection {...defaultSectionProps} count={5}>
        <div>Content</div>
      </InboxListSection>
    )

    expect(screen.getByText('5')).toBeInTheDocument()
  })

  it('should render section with icon', () => {
    render(
      <InboxListSection {...defaultSectionProps} icon={<span data-testid="icon">*</span>}>
        <div>Content</div>
      </InboxListSection>
    )

    expect(screen.getByTestId('icon')).toBeInTheDocument()
  })

  it('should be collapsible when collapsible prop is true', async () => {
    const user = userEvent.setup()

    render(
      <InboxListSection {...defaultSectionProps} collapsible>
        <div>Content</div>
      </InboxListSection>
    )

    expect(screen.getByText('Content')).toBeInTheDocument()

    await user.click(screen.getByText('Today'))

    expect(screen.queryByText('Content')).not.toBeInTheDocument()
  })

  it('should respect defaultCollapsed prop', () => {
    render(
      <InboxListSection {...defaultSectionProps} collapsible defaultCollapsed>
        <div>Content</div>
      </InboxListSection>
    )

    expect(screen.queryByText('Content')).not.toBeInTheDocument()
  })

  it('should have proper section aria-labelledby', () => {
    render(
      <InboxListSection {...defaultSectionProps}>
        <div>Content</div>
      </InboxListSection>
    )

    const section = screen.getByRole('region', { hidden: true }) || document.querySelector('section')
    expect(section).toHaveAttribute('aria-labelledby', 'section-today')
  })
})

// ============================================================================
// Accessibility Tests
// ============================================================================

describe('InboxList - accessibility', () => {
  it('should have proper list role', () => {
    const item = createInboxItem('note', { title: 'Test' })

    render(
      <InboxListSection {...defaultSectionProps}>
        <InboxListItem
          item={item}
          period="today"
          onPreview={vi.fn()}
          onArchive={vi.fn()}
        />
      </InboxListSection>
    )

    expect(screen.getByRole('listitem')).toBeInTheDocument()
  })

  it('should have proper checkbox labels', () => {
    const item = createInboxItem('note', { title: 'My Note' })

    render(
      <InboxListSection {...defaultSectionProps}>
        <InboxListItem
          item={item}
          period="today"
          onPreview={vi.fn()}
          onArchive={vi.fn()}
        />
      </InboxListSection>
    )

    expect(screen.getByRole('checkbox', { name: /select my note/i })).toBeInTheDocument()
  })

  it('should be keyboard navigable', () => {
    const item = createInboxItem('note', { id: 'item-1', title: 'Test' })

    render(
      <InboxListSection {...defaultSectionProps} focusedId="item-1">
        <InboxListItem
          item={item}
          period="today"
          onPreview={vi.fn()}
          onArchive={vi.fn()}
        />
      </InboxListSection>
    )

    const listItem = screen.getByRole('listitem')
    expect(listItem).toHaveAttribute('tabindex', '0')
  })
})
