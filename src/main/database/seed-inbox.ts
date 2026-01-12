/**
 * Inbox Database Seed
 * @module database/seed-inbox
 */

import { eq } from 'drizzle-orm'
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import { nanoid } from 'nanoid'
import {
  inboxItems,
  inboxItemTags,
  inboxStats,
  filingHistory,
  type InboxItemType
} from '@shared/db/schema/inbox'
import * as schema from '@shared/db/schema'

type DrizzleDb = BetterSQLite3Database<typeof schema>

function getRelativeDateTime(daysAgo: number, hours = 12, minutes = 0): string {
  const date = new Date()
  date.setDate(date.getDate() - daysAgo)
  date.setHours(hours, minutes, 0, 0)
  return date.toISOString()
}

function getDateString(daysAgo = 0): string {
  const date = new Date()
  date.setDate(date.getDate() - daysAgo)
  return date.toISOString().split('T')[0]
}

interface SampleInboxItem {
  id: string
  type: InboxItemType
  title: string
  content?: string
  daysAgo: number
  hours?: number
  minutes?: number
  sourceUrl?: string
  metadata?: Record<string, unknown>
  tags?: string[]
  processingStatus?: 'pending' | 'processing' | 'complete' | 'failed'
  transcription?: string
  transcriptionStatus?: 'pending' | 'processing' | 'complete' | 'failed'
}

const SAMPLE_INBOX_ITEMS: SampleInboxItem[] = [
  {
    id: 'inbox-seed-1',
    type: 'link',
    title: 'The Design of Everyday Things',
    content:
      "Don Norman's The Design of Everyday Things is a powerful primer on how—and why—some products satisfy customers while others only frustrate them.",
    daysAgo: 0,
    hours: 14,
    minutes: 34,
    sourceUrl: 'https://nngroup.com/articles/design-everyday-things',
    metadata: {
      url: 'https://nngroup.com/articles/design-everyday-things',
      siteName: 'Nielsen Norman Group',
      description:
        'A comprehensive guide to user-centered design principles that have shaped modern product development.',
      fetchStatus: 'success',
      fetchedAt: new Date().toISOString()
    },
    tags: ['design', 'ux', 'reading']
  },
  {
    id: 'inbox-seed-2',
    type: 'link',
    title: 'Atomic Design by Brad Frost',
    content:
      'Atomic design is a methodology for creating design systems. There are five distinct levels in atomic design.',
    daysAgo: 0,
    hours: 14,
    minutes: 12,
    sourceUrl: 'https://atomicdesign.bradfrost.com',
    metadata: {
      url: 'https://atomicdesign.bradfrost.com',
      siteName: 'Atomic Design',
      author: 'Brad Frost',
      fetchStatus: 'success',
      fetchedAt: new Date().toISOString()
    },
    tags: ['design-systems']
  },
  {
    id: 'inbox-seed-3',
    type: 'note',
    title: "API architecture question for Monday's meeting",
    content:
      'Need to discuss whether we should use REST or GraphQL for the new endpoints. Also consider rate limiting strategy and authentication flow.',
    daysAgo: 0,
    hours: 13,
    minutes: 45,
    tags: ['work', 'api', 'meeting']
  },
  {
    id: 'inbox-seed-4',
    type: 'voice',
    title: 'Voice memo - Project ideas',
    daysAgo: 0,
    hours: 11,
    minutes: 20,
    metadata: {
      duration: 34,
      format: 'webm',
      fileSize: 128000,
      sampleRate: 48000
    },
    transcription:
      'Thinking about the new feature implementation. We should probably start with the database schema first, then move to the API layer. Need to check with Sarah about the timeline.',
    transcriptionStatus: 'complete'
  },
  {
    id: 'inbox-seed-5',
    type: 'link',
    title: 'Design Tokens W3C Spec',
    content:
      'The Design Tokens Format Module defines a standard file format for expressing design tokens.',
    daysAgo: 1,
    hours: 18,
    minutes: 45,
    sourceUrl: 'https://design-tokens.github.io/community-group/format/',
    metadata: {
      url: 'https://design-tokens.github.io/community-group/format/',
      siteName: 'W3C Design Tokens Community Group',
      fetchStatus: 'success',
      fetchedAt: new Date().toISOString()
    },
    tags: ['design-systems', 'standards']
  },
  {
    id: 'inbox-seed-6',
    type: 'image',
    title: 'whiteboard-photo.png',
    content: 'Architecture diagram from design sync meeting',
    daysAgo: 1,
    hours: 15,
    minutes: 20,
    metadata: {
      originalFilename: 'whiteboard-photo.png',
      format: 'png',
      width: 1920,
      height: 1080,
      fileSize: 245000,
      hasExif: false,
      caption: 'System architecture whiteboard sketch'
    },
    tags: ['architecture', 'meeting']
  },
  {
    id: 'inbox-seed-7',
    type: 'note',
    title: 'Why semantic tokens matter for our design system',
    content:
      'Semantic tokens create a layer of abstraction that allows us to change the entire look and feel without touching components. They map primitive tokens to specific use cases like "color-text-primary" instead of "blue-500".',
    daysAgo: 1,
    hours: 14,
    minutes: 15,
    tags: ['design-systems']
  },
  {
    id: 'inbox-seed-8',
    type: 'social',
    title: '@dan_abramov on React Server Components',
    content:
      'Server Components are not about performance. They are about letting you move code between client and server easily.',
    daysAgo: 3,
    hours: 10,
    minutes: 30,
    sourceUrl: 'https://twitter.com/dan_abramov/status/1234567890',
    metadata: {
      platform: 'twitter',
      postUrl: 'https://twitter.com/dan_abramov/status/1234567890',
      authorName: 'Dan Abramov',
      authorHandle: 'dan_abramov',
      postContent:
        'Server Components are not about performance. They are about letting you move code between client and server easily.',
      timestamp: new Date(Date.now() - 3 * 24 * 60 * 60 * 1000).toISOString(),
      mediaUrls: [],
      metrics: { likes: 2500, reposts: 450, replies: 120 },
      extractionStatus: 'full'
    },
    tags: ['react', 'frontend']
  },
  {
    id: 'inbox-seed-9',
    type: 'link',
    title: 'Figma Variables Deep Dive',
    content:
      'Variables in Figma allow you to define reusable values for colors, numbers, strings, and booleans.',
    daysAgo: 4,
    hours: 10,
    minutes: 30,
    sourceUrl: 'https://figma.com/blog/variables',
    metadata: {
      url: 'https://figma.com/blog/variables',
      siteName: 'Figma Blog',
      fetchStatus: 'success',
      fetchedAt: new Date().toISOString()
    }
  },
  {
    id: 'inbox-seed-10',
    type: 'link',
    title: 'Component API patterns',
    content: 'A deep dive into different patterns for designing component APIs.',
    daysAgo: 9,
    hours: 12,
    minutes: 0,
    sourceUrl: 'https://medium.com/component-apis',
    metadata: {
      url: 'https://medium.com/component-apis',
      siteName: 'Medium',
      author: 'Sarah Chen',
      fetchStatus: 'success',
      fetchedAt: new Date().toISOString()
    },
    tags: ['components', 'api-design']
  },
  {
    id: 'inbox-seed-11',
    type: 'note',
    title: 'Meeting notes from design sync',
    content:
      'Discussed timeline for Q1 launch. Need to finalize token structure by end of month. Action items: review color palette, update typography scale, create component inventory.',
    daysAgo: 12,
    hours: 12,
    minutes: 0,
    tags: ['meeting', 'q1-planning']
  },
  {
    id: 'inbox-seed-12',
    type: 'link',
    title: 'Typography Best Practices for Digital Products',
    content:
      'Everything you need to know about choosing and using typography in digital interfaces.',
    daysAgo: 35,
    hours: 12,
    minutes: 0,
    sourceUrl: 'https://typography.com/blog/best-practices',
    metadata: {
      url: 'https://typography.com/blog/best-practices',
      siteName: 'Typography.com',
      fetchStatus: 'success',
      fetchedAt: new Date().toISOString()
    },
    tags: ['typography', 'design']
  }
]

interface SampleFilingHistory {
  itemType: string
  itemContent: string
  filedTo: string
  filedAction: 'folder' | 'note' | 'linked'
  tags: string[]
  daysAgo: number
}

const SAMPLE_FILING_HISTORY: SampleFilingHistory[] = [
  {
    itemType: 'link',
    itemContent: 'React 19 release notes and migration guide',
    filedTo: 'Development/React',
    filedAction: 'folder',
    tags: ['react', 'frontend'],
    daysAgo: 2
  },
  {
    itemType: 'note',
    itemContent: 'Sprint planning notes for Q1',
    filedTo: 'Work/Planning',
    filedAction: 'folder',
    tags: ['work', 'planning'],
    daysAgo: 3
  },
  {
    itemType: 'link',
    itemContent: 'CSS Container Queries tutorial',
    filedTo: 'Development/CSS',
    filedAction: 'folder',
    tags: ['css', 'frontend'],
    daysAgo: 5
  },
  {
    itemType: 'link',
    itemContent: 'Design system documentation patterns',
    filedTo: 'Design/Systems',
    filedAction: 'folder',
    tags: ['design-systems'],
    daysAgo: 7
  },
  {
    itemType: 'note',
    itemContent: 'API endpoint ideas for v2',
    filedTo: 'note-abc123',
    filedAction: 'linked',
    tags: ['api', 'v2'],
    daysAgo: 10
  }
]

interface DailyStats {
  daysAgo: number
  captureCountLink: number
  captureCountNote: number
  captureCountImage: number
  captureCountVoice: number
  captureCountClip: number
  captureCountPdf: number
  captureCountSocial: number
  processedCount: number
  archivedCount: number
}

/**
 * Seeded random number generator for reproducible stats
 * Uses a simple linear congruential generator
 */
function createSeededRandom(seed: number): () => number {
  let state = seed
  return () => {
    state = (state * 1103515245 + 12345) & 0x7fffffff
    return state / 0x7fffffff
  }
}

/**
 * Generate realistic inbox stats for the past 12 months (365 days)
 * with natural variation patterns:
 * - Weekdays are more active than weekends
 * - Links are the most common capture type
 * - Some days have no activity (holidays, vacations)
 * - Processing rate varies but generally keeps up with captures
 */
function generateYearlyStats(): DailyStats[] {
  const stats: DailyStats[] = []
  const random = createSeededRandom(42) // Consistent seed for reproducibility

  for (let daysAgo = 0; daysAgo < 365; daysAgo++) {
    const date = new Date()
    date.setDate(date.getDate() - daysAgo)
    const dayOfWeek = date.getDay() // 0 = Sunday, 6 = Saturday
    const isWeekend = dayOfWeek === 0 || dayOfWeek === 6

    // Base activity multiplier (weekends are quieter)
    const activityMultiplier = isWeekend ? 0.4 : 1.0

    // Random chance of a "quiet day" (vacation, holiday, etc.)
    const isQuietDay = random() < 0.1

    if (isQuietDay) {
      // Quiet days have minimal or no activity
      stats.push({
        daysAgo,
        captureCountLink: random() < 0.3 ? 1 : 0,
        captureCountNote: 0,
        captureCountImage: 0,
        captureCountVoice: 0,
        captureCountClip: 0,
        captureCountPdf: 0,
        captureCountSocial: 0,
        processedCount: random() < 0.5 ? 1 : 0,
        archivedCount: 0
      })
      continue
    }

    // Generate capture counts with realistic distribution
    // Links are most common, followed by notes, then others
    const captureCountLink = Math.floor(random() * 5 * activityMultiplier)
    const captureCountNote = Math.floor(random() * 3 * activityMultiplier)
    const captureCountImage = random() < 0.2 * activityMultiplier ? Math.floor(random() * 2) + 1 : 0
    const captureCountVoice = random() < 0.15 * activityMultiplier ? 1 : 0
    const captureCountClip = random() < 0.1 * activityMultiplier ? 1 : 0
    const captureCountPdf = random() < 0.08 * activityMultiplier ? 1 : 0
    const captureCountSocial =
      random() < 0.12 * activityMultiplier ? Math.floor(random() * 2) + 1 : 0

    const totalCaptures =
      captureCountLink +
      captureCountNote +
      captureCountImage +
      captureCountVoice +
      captureCountClip +
      captureCountPdf +
      captureCountSocial

    // Processing rate: usually process 60-90% of captures
    const processingRate = 0.6 + random() * 0.3
    const processedCount = Math.floor(totalCaptures * processingRate)

    // Archive rate: occasionally archive some items (10-20% of processed)
    const archivedCount = random() < 0.3 ? Math.floor(processedCount * (0.1 + random() * 0.1)) : 0

    stats.push({
      daysAgo,
      captureCountLink,
      captureCountNote,
      captureCountImage,
      captureCountVoice,
      captureCountClip,
      captureCountPdf,
      captureCountSocial,
      processedCount,
      archivedCount
    })
  }

  return stats
}

// Generate stats for all 12 months
const SAMPLE_STATS: DailyStats[] = generateYearlyStats()

export function seedSampleInboxItems(db: DrizzleDb): void {
  console.log('Seeding sample inbox items...')

  let seededCount = 0
  let skippedCount = 0

  for (const item of SAMPLE_INBOX_ITEMS) {
    const existing = db.select().from(inboxItems).where(eq(inboxItems.id, item.id)).get()

    if (existing) {
      skippedCount++
      continue
    }

    const createdAt = getRelativeDateTime(item.daysAgo, item.hours ?? 12, item.minutes ?? 0)

    db.insert(inboxItems)
      .values({
        id: item.id,
        type: item.type,
        title: item.title,
        content: item.content ?? null,
        createdAt,
        modifiedAt: createdAt,
        sourceUrl: item.sourceUrl ?? null,
        metadata: item.metadata ?? null,
        processingStatus: item.processingStatus ?? 'complete',
        transcription: item.transcription ?? null,
        transcriptionStatus: item.transcriptionStatus ?? null
      })
      .run()

    if (item.tags && item.tags.length > 0) {
      for (const tag of item.tags) {
        db.insert(inboxItemTags)
          .values({
            id: `tag-${item.id}-${tag}`,
            itemId: item.id,
            tag,
            createdAt
          })
          .run()
      }
    }

    seededCount++
  }

  console.log(`Seeded ${seededCount} inbox items (${skippedCount} already existed)`)
}

export function seedFilingHistory(db: DrizzleDb): void {
  console.log('Seeding filing history...')

  let seededCount = 0

  for (const history of SAMPLE_FILING_HISTORY) {
    const id = `filing-seed-${nanoid(8)}`
    const filedAt = getRelativeDateTime(history.daysAgo)

    const existing = db
      .select()
      .from(filingHistory)
      .where(eq(filingHistory.itemContent, history.itemContent))
      .get()

    if (existing) {
      continue
    }

    db.insert(filingHistory)
      .values({
        id,
        itemType: history.itemType,
        itemContent: history.itemContent,
        filedTo: history.filedTo,
        filedAction: history.filedAction,
        tags: history.tags,
        filedAt
      })
      .run()

    seededCount++
  }

  console.log(`Seeded ${seededCount} filing history entries`)
}

export function seedInboxStats(db: DrizzleDb): void {
  console.log('Seeding inbox stats...')

  let seededCount = 0

  for (const stats of SAMPLE_STATS) {
    const date = getDateString(stats.daysAgo)
    const id = `stats-seed-${date}`

    const existing = db.select().from(inboxStats).where(eq(inboxStats.date, date)).get()

    if (existing) {
      continue
    }

    db.insert(inboxStats)
      .values({
        id,
        date,
        captureCountLink: stats.captureCountLink,
        captureCountNote: stats.captureCountNote,
        captureCountImage: stats.captureCountImage,
        captureCountVoice: stats.captureCountVoice,
        captureCountClip: stats.captureCountClip,
        captureCountPdf: stats.captureCountPdf,
        captureCountSocial: stats.captureCountSocial,
        processedCount: stats.processedCount,
        archivedCount: stats.archivedCount
      })
      .run()

    seededCount++
  }

  console.log(`Seeded ${seededCount} days of inbox stats (12 months)`)
}

export function seedAllInboxData(db: DrizzleDb): void {
  seedSampleInboxItems(db)
  seedFilingHistory(db)
  seedInboxStats(db)
}
