import type { InboxItemListItem } from '@/types'

// Helper to create dates relative to today
const createDate = (daysAgo: number, hours: number, minutes: number): Date => {
  const date = new Date()
  date.setDate(date.getDate() - daysAgo)
  date.setHours(hours, minutes, 0, 0)
  return date
}

/**
 * Sample inbox items for development and demo purposes.
 * Uses InboxItemListItem type to match the backend list response.
 */
export const sampleInboxItems: InboxItemListItem[] = [
  // TODAY items
  {
    id: '1',
    type: 'link',
    title: 'The Design of Everyday Things',
    createdAt: createDate(0, 14, 34), // today at 2:34 PM
    sourceUrl: 'https://nngroup.com/articles/design-everyday-things',
    content:
      "Don Norman's The Design of Everyday Things is a powerful primer on how—and why—some products satisfy customers while others only frustrate them.",
    thumbnailUrl: null,
    tags: [],
    isStale: false,
    processingStatus: 'complete'
  },
  {
    id: '2',
    type: 'link',
    title: 'Atomic Design by Brad Frost',
    createdAt: createDate(0, 14, 12), // today at 2:12 PM
    sourceUrl: 'https://atomicdesign.bradfrost.com',
    content:
      'Atomic design is a methodology for creating design systems. There are five distinct levels in atomic design.',
    thumbnailUrl: null,
    tags: [],
    isStale: false,
    processingStatus: 'complete'
  },
  {
    id: '3',
    type: 'note',
    title: "API architecture question for Monday's meeting",
    createdAt: createDate(0, 13, 45), // today at 1:45 PM
    sourceUrl: null,
    content:
      'Need to discuss whether we should use REST or GraphQL for the new endpoints. Also consider rate limiting strategy.',
    thumbnailUrl: null,
    tags: [],
    isStale: false,
    processingStatus: 'complete'
  },
  {
    id: '4',
    type: 'voice',
    title: 'Voice memo',
    createdAt: createDate(0, 11, 20), // today at 11:20 AM
    sourceUrl: null,
    content: null,
    thumbnailUrl: null,
    tags: [],
    isStale: false,
    processingStatus: 'complete',
    duration: 34
  },

  // YESTERDAY items
  {
    id: '5',
    type: 'link',
    title: 'Design Tokens W3C Spec',
    createdAt: createDate(1, 18, 45), // yesterday at 6:45 PM
    sourceUrl: 'https://design-tokens.github.io/community-group/format/',
    content:
      'The Design Tokens Format Module defines a standard file format for expressing design tokens.',
    thumbnailUrl: null,
    tags: [],
    isStale: false,
    processingStatus: 'complete'
  },
  {
    id: '6',
    type: 'image',
    title: 'whiteboard-photo.png',
    createdAt: createDate(1, 15, 20), // yesterday at 3:20 PM
    sourceUrl: null,
    content: 'Architecture diagram from design sync',
    thumbnailUrl: null,
    tags: [],
    isStale: false,
    processingStatus: 'complete'
  },
  {
    id: '7',
    type: 'note',
    title: 'Why semantic tokens matter for our design system',
    createdAt: createDate(1, 14, 15), // yesterday at 2:15 PM
    sourceUrl: null,
    content:
      'Semantic tokens create a layer of abstraction that allows us to change the entire look and feel without touching components.',
    thumbnailUrl: null,
    tags: [],
    isStale: false,
    processingStatus: 'complete'
  },

  // OLDER items (not stale, 2-6 days old)
  {
    id: '8',
    type: 'link',
    title: 'Figma Variables Deep Dive',
    createdAt: createDate(4, 10, 30), // 4 days ago at 10:30 AM
    sourceUrl: 'https://figma.com/blog/variables',
    content:
      'Variables in Figma allow you to define reusable values for colors, numbers, strings, and booleans.',
    thumbnailUrl: null,
    tags: [],
    isStale: false,
    processingStatus: 'complete'
  },

  // STALE items (7+ days old - these appear in NEEDS ATTENTION section)
  {
    id: '9',
    type: 'link',
    title: 'Component API patterns',
    createdAt: createDate(9, 12, 0), // 9 days ago
    sourceUrl: 'https://medium.com/component-apis',
    content: 'A deep dive into different patterns for designing component APIs.',
    thumbnailUrl: null,
    tags: [],
    isStale: true,
    processingStatus: 'complete'
  },
  {
    id: '10',
    type: 'link',
    title: 'Design system governance models',
    createdAt: createDate(10, 12, 0), // 10 days ago
    sourceUrl: 'https://designsystems.com/governance',
    content: 'How successful organizations manage and evolve their design systems.',
    thumbnailUrl: null,
    tags: [],
    isStale: true,
    processingStatus: 'complete'
  },
  {
    id: '11',
    type: 'note',
    title: 'Meeting notes from design sync',
    createdAt: createDate(12, 12, 0), // 12 days ago
    sourceUrl: null,
    content: 'Discussed timeline for Q1 launch. Need to finalize token structure by end of month.',
    thumbnailUrl: null,
    tags: [],
    isStale: true,
    processingStatus: 'complete'
  },
  {
    id: '12',
    type: 'link',
    title: 'Old article about typography',
    createdAt: createDate(35, 12, 0), // 35 days ago - tests "Over a month" formatting
    sourceUrl: 'https://typography.com/blog/best-practices',
    content: 'Typography best practices for digital products.',
    thumbnailUrl: null,
    tags: [],
    isStale: true,
    processingStatus: 'complete'
  }
]
