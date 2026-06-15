import { generateId } from '../../src/main/lib/id'
import type { SeedFilingHistory, SeedInboxItem } from '../seed-vault/db-writer'
import { seedDateOnly, seedPastISOAt } from './date'

const offsetISO = (days: number, hours = 11): string => {
  return seedPastISOAt(days, hours, 17)
}

const id = (prefix: string): string => `inbox_${prefix}_${generateId().slice(0, 12)}`

export const INBOX_ITEMS: SeedInboxItem[] = [
  // ========================================================================
  // YouTube video — today
  // ========================================================================
  {
    id: id('lnk'),
    type: 'link',
    title: 'YouTube — 20-minute weeknight ramen',
    content: 'Dinner idea for this week. Save the tare shortcut and grocery list.',
    sourceUrl: 'https://www.youtube.com/watch?v=weeknight-ramen',
    sourceTitle: '20-minute weeknight ramen — YouTube',
    captureSource: 'browser-extension',
    metadata: {
      channel: 'Kitchen Stories',
      publisher: 'YouTube',
      duration: '12:44',
      image: 'https://img.youtube.com/vi/weeknight-ramen/maxresdefault.jpg'
    },
    createdAt: offsetISO(0, 8),
    modifiedAt: offsetISO(0, 8),
    tags: ['projects/personal', 'food']
  },

  // ========================================================================
  // Travel guide link
  // ========================================================================
  {
    id: id('lnk'),
    type: 'link',
    title: 'Lisbon weekend guide from a local',
    content: 'Good breakfast spots, viewpoints, and one bookstore to check before the trip.',
    sourceUrl: 'https://example.com/lisbon-weekend-guide',
    sourceTitle: 'A local weekend in Lisbon',
    captureSource: 'browser-extension',
    metadata: {
      publisher: 'Travel Notes',
      author: 'Marta Alves',
      readingTime: 9,
      updatedAt: seedDateOnly(-2)
    },
    createdAt: offsetISO(-1, 14),
    modifiedAt: offsetISO(-1, 14),
    tags: ['travel/europe', 'weekend']
  },

  // ========================================================================
  // Snoozed Twitter/X thread
  // ========================================================================
  {
    id: id('lnk'),
    type: 'link',
    title: 'Twitter/X thread — carry-on packing tips',
    content: 'Useful replies with charger, shoe, and toiletry tips. Read before packing.',
    sourceUrl: 'https://x.com/travelnotes/status/1234567890',
    captureSource: 'quick-capture',
    snoozedUntil: offsetISO(1, 9),
    snoozeReason: 'Review tomorrow before starting the packing list',
    metadata: { platform: 'x', authorHandle: '@travelnotes' },
    createdAt: offsetISO(-2, 22),
    modifiedAt: offsetISO(-2, 22),
    tags: ['travel/asia', 'packing']
  },

  // ========================================================================
  // Quick note — text capture
  // ========================================================================
  {
    id: id('nt'),
    type: 'note',
    title: 'Buy basil, lemons, and sparkling water',
    content: 'For Sunday dinner. Check the fridge first so we do not double-buy herbs.',
    captureSource: 'quick-capture',
    createdAt: offsetISO(0, 7),
    modifiedAt: offsetISO(0, 7),
    tags: ['projects/personal', 'errands']
  },

  // ========================================================================
  // Voice memo with transcription
  // ========================================================================
  {
    id: id('vcr'),
    type: 'voice',
    title: `Voice memo — ${seedDateOnly(-1)} 22:14`,
    content: 'Transcription pending review',
    transcription:
      'Remember to book the dog sitter before we confirm the cabin weekend. Also check whether the place has a fenced yard and late checkout. Send Mina the two options in the morning.',
    transcriptionStatus: 'complete',
    captureSource: 'quick-capture',
    attachmentPath: `attachments/inbox/voice-${seedDateOnly(-1)}.m4a`,
    createdAt: offsetISO(-1, 22),
    modifiedAt: offsetISO(-1, 22),
    tags: ['projects/personal', 'travel']
  },

  // ========================================================================
  // Voice memo — second one
  // ========================================================================
  {
    id: id('vcr'),
    type: 'voice',
    title: 'Voice memo — birthday dinner idea',
    transcription:
      'For Dad birthday dinner, maybe make the lemon chicken from last summer and ask everyone to bring one photo from the year. Need to reserve the bigger table if we go out instead.',
    transcriptionStatus: 'complete',
    captureSource: 'quick-capture',
    attachmentPath: `attachments/inbox/voice-${seedDateOnly(-3)}.m4a`,
    createdAt: offsetISO(-3, 21),
    modifiedAt: offsetISO(-3, 21),
    tags: ['projects/personal', 'family']
  },

  // ========================================================================
  // Image — shopping screenshot
  // ========================================================================
  {
    id: id('img'),
    type: 'image',
    title: 'Screenshot — sofa color options',
    content: 'Cream vs olive swatches for the living room. Compare against the rug photo.',
    captureSource: 'browser-extension',
    attachmentPath: 'attachments/inbox/sofa-color-options.png',
    thumbnailPath: 'attachments/inbox/sofa-color-options.thumb.png',
    metadata: { width: 1840, height: 1080 },
    createdAt: offsetISO(0, 9),
    modifiedAt: offsetISO(0, 9),
    tags: ['projects/home', 'shopping']
  },

  // ========================================================================
  // PDF
  // ========================================================================
  {
    id: id('pdf'),
    type: 'pdf',
    title: 'Apartment lease renewal packet',
    content: 'Read before Friday. Check pet clause, parking fee, and renewal date.',
    sourceUrl: 'https://example.com/docs/lease-renewal.pdf',
    captureSource: 'browser-extension',
    attachmentPath: 'attachments/inbox/lease-renewal.pdf',
    metadata: { pages: 12, fileSize: 840000 },
    createdAt: offsetISO(-4, 13),
    modifiedAt: offsetISO(-4, 13),
    tags: ['projects/home', 'admin']
  },

  // ========================================================================
  // Reminder
  // ========================================================================
  {
    id: id('rmd'),
    type: 'reminder',
    title: 'Water the balcony herbs',
    content: 'Basil is drooping again. Move the mint out of direct sun if it is still yellow.',
    captureSource: 'reminder',
    metadata: { sourceNoteId: 'balcony-garden-note' },
    createdAt: offsetISO(-5, 9),
    modifiedAt: offsetISO(-5, 9),
    tags: ['projects/home', 'reminders']
  },

  // ========================================================================
  // Web clip with sourceTitle
  // ========================================================================
  {
    id: id('clp'),
    type: 'clip',
    title: 'Excerpt: "The best trips leave room for wandering."',
    content:
      'Save this paragraph for the Lisbon planning note. Nice reminder not to over-schedule every meal.',
    sourceUrl: 'https://example.com/essay/slow-travel-lisbon',
    sourceTitle: 'Slow mornings in Lisbon — Substack',
    captureSource: 'browser-extension',
    metadata: { publisher: 'Substack', author: 'Nora Lane' },
    createdAt: offsetISO(-2, 15),
    modifiedAt: offsetISO(-2, 15),
    tags: ['travel/europe', 'reflection']
  },

  // ========================================================================
  // Filed recipe link
  // ========================================================================
  {
    id: id('lnk'),
    type: 'link',
    title: 'Recipe — lemon ricotta pancakes',
    sourceUrl: 'https://example.com/recipes/lemon-ricotta-pancakes',
    captureSource: 'browser-extension',
    filedAt: offsetISO(-3, 16),
    filedTo: 'food/Lemon Ricotta Pancakes.md',
    filedAction: 'note',
    metadata: { publisher: 'Kitchen Journal', readingTime: 6 },
    createdAt: offsetISO(-4, 11),
    modifiedAt: offsetISO(-3, 16),
    tags: ['projects/personal', 'food']
  },

  // ========================================================================
  // Snoozed note with reason
  // ========================================================================
  {
    id: id('nt'),
    type: 'note',
    title: 'Pick a birthday gift for Dad',
    content: 'Maybe the cast-iron pan, a framed photo, or tickets to the jazz night.',
    captureSource: 'quick-capture',
    snoozedUntil: offsetISO(7, 9),
    snoozeReason: 'Decide next week so there is time for shipping',
    createdAt: offsetISO(-1, 11),
    modifiedAt: offsetISO(-1, 11),
    tags: ['projects/personal', 'family']
  },

  // ========================================================================
  // Reddit social post
  // ========================================================================
  {
    id: id('soc'),
    type: 'social',
    title: 'Reddit — which carry-on suitcase actually lasts?',
    content:
      'Long thread with real owner photos. Compare Away, Monos, and Travelpro before buying.',
    sourceUrl: 'https://reddit.com/r/BuyItForLife/comments/carry_on_luggage/',
    sourceTitle: 'r/BuyItForLife — which carry-on suitcase actually lasts?',
    captureSource: 'browser-extension',
    metadata: { platform: 'reddit', upvotes: 1820, comments: 432 },
    createdAt: offsetISO(0, 12),
    modifiedAt: offsetISO(0, 12),
    tags: ['travel/asia', 'shopping']
  },

  // ========================================================================
  // Article link
  // ========================================================================
  {
    id: id('lnk'),
    type: 'link',
    title: 'Best farmers markets in Istanbul this spring',
    content: 'Save for a weekend walk. The Kadikoy section has three stalls to try.',
    sourceUrl: 'https://example.com/istanbul-farmers-markets',
    sourceTitle: 'Best farmers markets in Istanbul this spring',
    captureSource: 'browser-extension',
    metadata: { author: 'Leyla Demir', readingTime: 7 },
    createdAt: offsetISO(-2, 9),
    modifiedAt: offsetISO(-2, 9),
    tags: ['projects/personal', 'food']
  },

  // ========================================================================
  // Old archived item
  // ========================================================================
  {
    id: id('nt'),
    type: 'note',
    title: 'Old note — try candle-making class',
    content: 'Archived because the weekend filled up.',
    captureSource: 'quick-capture',
    archivedAt: offsetISO(-95, 18),
    createdAt: offsetISO(-180, 11),
    modifiedAt: offsetISO(-95, 18),
    tags: ['projects/personal']
  }
]

export const FILING_HISTORY_ROWS: SeedFilingHistory[] = [
  {
    id: generateId(),
    itemType: 'link',
    itemContent: 'Recipe: lemon ricotta pancakes — weekend breakfast idea',
    filedTo: 'food/Lemon Ricotta Pancakes.md',
    filedAction: 'note',
    tags: ['projects/personal', 'food'],
    filedAt: offsetISO(-3, 16)
  },
  {
    id: generateId(),
    itemType: 'link',
    itemContent: 'Weekend hike in Marin — trail map and picnic stop',
    filedTo: 'travel/Marin Weekend.md',
    filedAction: 'note',
    tags: ['projects/personal', 'fitness'],
    filedAt: offsetISO(-9, 14)
  },
  {
    id: generateId(),
    itemType: 'note',
    itemContent: 'Birthday dinner ideas for Dad',
    filedTo: 'life/Birthday Plans.md',
    filedAction: 'note',
    tags: ['projects/personal', 'family'],
    filedAt: offsetISO(-15, 11)
  }
]
