import { describe, it, expect } from 'vitest'
import type { InboxItemListItem } from '@/types'
import { detectClusters, getClusterKey } from './ai-clustering'

// ============================================================================
// MOCK FACTORY
// ============================================================================

const createInboxItem = (overrides: Partial<InboxItemListItem> = {}): InboxItemListItem => ({
  id: 'item-1',
  type: 'link',
  title: 'Sample Item',
  content: null,
  createdAt: new Date(2026, 0, 1),
  thumbnailUrl: null,
  sourceUrl: null,
  tags: [],
  isStale: false,
  processingStatus: 'complete',
  ...overrides
})

// ============================================================================
// TESTS
// ============================================================================

describe('ai-clustering', () => {
  describe('T200: detectClusters type-based clustering', () => {
    it('suggests unselected items of the same type', () => {
      const selected = [
        createInboxItem({
          id: 'selected-link',
          type: 'link',
          title: 'Selected Link',
          sourceUrl: 'https://example.com/selected'
        })
      ]

      const linkOne = createInboxItem({
        id: 'link-1',
        type: 'link',
        title: 'Another Link',
        sourceUrl: 'https://example.com/one'
      })
      const noteItem = createInboxItem({
        id: 'note-1',
        type: 'note',
        title: 'A Note'
      })
      const linkTwo = createInboxItem({
        id: 'link-2',
        type: 'link',
        title: 'Second Link',
        sourceUrl: 'https://other.com/two'
      })

      const allItems = [selected[0], linkOne, noteItem, linkTwo]
      const result = detectClusters(selected, allItems)

      expect(result).not.toBeNull()
      expect(result?.items.map((item) => item.id)).toEqual(['link-1', 'link-2'])
      expect(result?.reason).toBe('2 more links')
    })
  })

  describe('T201: detectClusters domain-based clustering', () => {
    it('clusters links from the same domain when selection spans types', () => {
      const selectedLink = createInboxItem({
        id: 'selected-link',
        type: 'link',
        title: 'Selected Link',
        sourceUrl: 'https://www.example.com/selected'
      })
      const selectedNote = createInboxItem({
        id: 'selected-note',
        type: 'note',
        title: 'Selected Note'
      })

      const sameDomainOne = createInboxItem({
        id: 'link-1',
        type: 'link',
        title: 'Same Domain One',
        sourceUrl: 'https://example.com/one'
      })
      const otherDomain = createInboxItem({
        id: 'link-2',
        type: 'link',
        title: 'Other Domain',
        sourceUrl: 'https://other.com/two'
      })
      const sameDomainTwo = createInboxItem({
        id: 'link-3',
        type: 'link',
        title: 'Same Domain Two',
        sourceUrl: 'https://example.com/three'
      })

      const allItems = [selectedLink, selectedNote, sameDomainOne, otherDomain, sameDomainTwo]
      const result = detectClusters([selectedLink, selectedNote], allItems)

      expect(result).not.toBeNull()
      expect(result?.items.map((item) => item.id)).toEqual(['link-1', 'link-3'])
      expect(result?.reason).toBe('2 more from example.com')
    })
  })

  describe('T202: getClusterKey', () => {
    it('creates a stable key with sorted item IDs', () => {
      const suggestion = {
        reason: '2 more links',
        items: [createInboxItem({ id: 'b' }), createInboxItem({ id: 'a' })]
      }

      expect(getClusterKey(suggestion)).toBe('2 more links:a,b')
    })
  })
})
