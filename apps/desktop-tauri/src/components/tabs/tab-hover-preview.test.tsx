import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen } from '@testing-library/react'
import { TabHoverPreview } from './tab-hover-preview'
import type { Tab } from '@/contexts/tabs/types'

const createTab = (overrides: Partial<Tab> = {}): Tab => ({
  id: 'tab-1',
  type: 'note',
  title: 'My Note',
  icon: 'file-text',
  path: '/notes/my-note',
  entityId: 'note-1',
  isPinned: false,
  isModified: false,
  isPreview: false,
  isDeleted: false,
  openedAt: Date.now(),
  lastAccessedAt: Date.now(),
  ...overrides
})

describe('TabHoverPreview', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  describe('non-note tabs', () => {
    it('should render children directly for inbox tabs', () => {
      // #given
      const tab = createTab({ type: 'inbox', title: 'Inbox' })

      // #when
      render(
        <TabHoverPreview tab={tab}>
          <div data-testid="tab-content">Inbox Tab</div>
        </TabHoverPreview>
      )

      // #then — children rendered, no hover card wrapper
      expect(screen.getByTestId('tab-content')).toBeInTheDocument()
      expect(screen.queryByRole('link')).not.toBeInTheDocument()
    })

    it('should render children directly for tasks tabs', () => {
      // #given
      const tab = createTab({ type: 'tasks', title: 'Tasks' })

      // #when
      render(
        <TabHoverPreview tab={tab}>
          <div data-testid="tab-content">Tasks Tab</div>
        </TabHoverPreview>
      )

      // #then
      expect(screen.getByTestId('tab-content')).toBeInTheDocument()
    })

    it('should render children directly for graph tabs', () => {
      // #given
      const tab = createTab({ type: 'graph', title: 'Graph' })

      // #when
      render(
        <TabHoverPreview tab={tab}>
          <div data-testid="tab-content">Graph Tab</div>
        </TabHoverPreview>
      )

      // #then
      expect(screen.getByTestId('tab-content')).toBeInTheDocument()
    })
  })

  describe('note tabs', () => {
    it('should render children for note tabs', () => {
      // #given
      const tab = createTab({ type: 'note', title: 'My Note' })

      // #when
      render(
        <TabHoverPreview tab={tab}>
          <div data-testid="tab-content">Note Tab</div>
        </TabHoverPreview>
      )

      // #then — children still rendered (HoverCardTrigger wraps them)
      expect(screen.getByTestId('tab-content')).toBeInTheDocument()
    })

    it('should render children for journal tabs', () => {
      // #given
      const tab = createTab({ type: 'journal', title: 'March 28' })

      // #when
      render(
        <TabHoverPreview tab={tab}>
          <div data-testid="tab-content">Journal Tab</div>
        </TabHoverPreview>
      )

      // #then
      expect(screen.getByTestId('tab-content')).toBeInTheDocument()
    })
  })

  describe('previewable tab types', () => {
    const previewableTypes = ['note', 'journal', 'file'] as const
    const nonPreviewableTypes = ['inbox', 'tasks', 'graph', 'search', 'templates'] as const

    it.each(previewableTypes)('should wrap %s tab with hover card trigger', (tabType) => {
      // #given
      const tab = createTab({ type: tabType })

      // #when
      render(
        <TabHoverPreview tab={tab}>
          <div data-testid="tab-content">Tab</div>
        </TabHoverPreview>
      )

      // #then — wrapper div with data-tab-hover-trigger has the hover-card-trigger slot
      const wrapper = screen.getByTestId('tab-content').closest('[data-tab-hover-trigger]')
      expect(wrapper).toBeInTheDocument()
      expect(wrapper?.closest('[data-slot="hover-card-trigger"]') ?? wrapper).toHaveAttribute(
        'data-tab-hover-trigger'
      )
    })

    it.each(nonPreviewableTypes)('should NOT wrap %s tab with hover card trigger', (tabType) => {
      // #given
      const tab = createTab({ type: tabType })

      // #when
      render(
        <TabHoverPreview tab={tab}>
          <div data-testid="tab-content">Tab</div>
        </TabHoverPreview>
      )

      // #then — no wrapper div
      const wrapper = screen.getByTestId('tab-content').closest('[data-tab-hover-trigger]')
      expect(wrapper).toBeNull()
    })
  })
})
