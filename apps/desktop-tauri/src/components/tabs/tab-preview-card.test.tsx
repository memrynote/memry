import { describe, it, expect } from 'vitest'
import { render, screen, within } from '@testing-library/react'
import { TabPreviewCard } from './tab-preview-card'
import type { WikiLinkPreview } from '@/services/notes-service'

const createPreview = (overrides: Partial<WikiLinkPreview> = {}): WikiLinkPreview => ({
  id: 'note-1',
  title: 'CRDT Sync Architecture',
  emoji: null,
  snippet: 'Setting up the sync engine with CRDT-based conflict resolution for offline-first',
  tags: [
    { name: 'sync', color: 'blue' },
    { name: 'crdt', color: 'green' }
  ],
  createdAt: '2026-03-15T10:00:00Z',
  ...overrides
})

describe('TabPreviewCard', () => {
  describe('title rendering', () => {
    it('should render the note title', () => {
      // #given
      const preview = createPreview()

      // #when
      render(<TabPreviewCard preview={preview} />)

      // #then
      expect(screen.getByText('CRDT Sync Architecture')).toBeInTheDocument()
    })

    it('should render emoji when present', () => {
      // #given
      const preview = createPreview({ emoji: '📝' })

      // #when
      render(<TabPreviewCard preview={preview} />)

      // #then
      expect(screen.getByText('📝')).toBeInTheDocument()
    })

    it('should render fallback icon when no emoji', () => {
      // #given
      const preview = createPreview({ emoji: null })

      // #when
      render(<TabPreviewCard preview={preview} />)

      // #then
      expect(screen.getByLabelText('Note icon')).toBeInTheDocument()
    })
  })

  describe('snippet rendering', () => {
    it('should render the snippet text', () => {
      // #given
      const preview = createPreview({
        snippet: 'A brief note about testing patterns'
      })

      // #when
      render(<TabPreviewCard preview={preview} />)

      // #then
      expect(screen.getByText('A brief note about testing patterns')).toBeInTheDocument()
    })

    it('should not render snippet section when snippet is null', () => {
      // #given
      const preview = createPreview({ snippet: null })

      // #when
      render(<TabPreviewCard preview={preview} />)

      // #then
      expect(screen.queryByTestId('tab-preview-snippet')).not.toBeInTheDocument()
    })
  })

  describe('tags rendering', () => {
    it('should render all tags when 3 or fewer', () => {
      // #given
      const preview = createPreview({
        tags: [
          { name: 'sync', color: 'blue' },
          { name: 'crdt', color: 'green' },
          { name: 'rust', color: 'red' }
        ]
      })

      // #when
      render(<TabPreviewCard preview={preview} />)

      // #then
      expect(screen.getByText('sync')).toBeInTheDocument()
      expect(screen.getByText('crdt')).toBeInTheDocument()
      expect(screen.getByText('rust')).toBeInTheDocument()
    })

    it('should show overflow count when more than 3 tags', () => {
      // #given
      const preview = createPreview({
        tags: [
          { name: 'sync', color: 'blue' },
          { name: 'crdt', color: 'green' },
          { name: 'rust', color: 'red' },
          { name: 'wasm', color: 'purple' },
          { name: 'perf', color: 'yellow' }
        ]
      })

      // #when
      render(<TabPreviewCard preview={preview} />)

      // #then — first 3 visible, overflow shows "+2"
      expect(screen.getByText('sync')).toBeInTheDocument()
      expect(screen.getByText('crdt')).toBeInTheDocument()
      expect(screen.getByText('rust')).toBeInTheDocument()
      expect(screen.queryByText('wasm')).not.toBeInTheDocument()
      expect(screen.queryByText('perf')).not.toBeInTheDocument()
      expect(screen.getByText('+2')).toBeInTheDocument()
    })

    it('should not render tags section when no tags', () => {
      // #given
      const preview = createPreview({ tags: [] })

      // #when
      render(<TabPreviewCard preview={preview} />)

      // #then
      expect(screen.queryByTestId('tab-preview-tags')).not.toBeInTheDocument()
    })
  })

  describe('date rendering', () => {
    it('should render formatted date', () => {
      // #given
      const preview = createPreview({ createdAt: '2026-03-15T10:00:00Z' })

      // #when
      render(<TabPreviewCard preview={preview} />)

      // #then
      expect(screen.getByText('Mar 15, 2026')).toBeInTheDocument()
    })
  })

  describe('loading state', () => {
    it('should render skeleton when isLoading is true', () => {
      // #when
      render(<TabPreviewCard preview={null} isLoading />)

      // #then
      expect(screen.getByTestId('tab-preview-skeleton')).toBeInTheDocument()
    })

    it('should not render skeleton when loaded', () => {
      // #given
      const preview = createPreview()

      // #when
      render(<TabPreviewCard preview={preview} isLoading={false} />)

      // #then
      expect(screen.queryByTestId('tab-preview-skeleton')).not.toBeInTheDocument()
    })
  })

  describe('null preview', () => {
    it('should render nothing when preview is null and not loading', () => {
      // #when
      const { container } = render(<TabPreviewCard preview={null} />)

      // #then
      expect(container.firstChild).toBeNull()
    })
  })
})
