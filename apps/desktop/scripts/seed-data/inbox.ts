import { generateId } from '../../src/main/lib/id'
import type { SeedFilingHistory, SeedInboxItem } from '../seed-vault/db-writer'

const TODAY = new Date('2026-05-08T12:00:00.000Z')

const offsetISO = (days: number, hours = 11): string => {
  const d = new Date(TODAY)
  d.setUTCDate(d.getUTCDate() + days)
  d.setUTCHours(hours, 17, 0, 0)
  return d.toISOString()
}

const id = (prefix: string): string => `inbox_${prefix}_${generateId().slice(0, 12)}`

export const INBOX_ITEMS: SeedInboxItem[] = [
  // ========================================================================
  // Unfiled link — today
  // ========================================================================
  {
    id: id('lnk'),
    type: 'link',
    title: 'How (and why) we built a CRDT for our editor',
    content:
      'Engineering blog post on building a CRDT-backed editor. Worth reading before the next CRDT review.',
    sourceUrl: 'https://example.com/crdt-editor-deep-dive',
    sourceTitle: 'How (and why) we built a CRDT for our editor — Engineering Blog',
    captureSource: 'browser-extension',
    metadata: {
      author: 'Mira S.',
      publisher: 'Engineering Blog',
      image: 'https://example.com/og/crdt-editor.png',
      readingTime: 14
    },
    createdAt: offsetISO(0, 8),
    modifiedAt: offsetISO(0, 8),
    tags: ['research', 'tech/sync']
  },

  // ========================================================================
  // GitHub repo — yjs/yjs
  // ========================================================================
  {
    id: id('lnk'),
    type: 'link',
    title: 'yjs/yjs — Shared data types for collaborative apps',
    content:
      'Repo I keep referring back to. Star count grew 4× since 2023. Maintained by Kevin Jahns.',
    sourceUrl: 'https://github.com/yjs/yjs',
    sourceTitle: 'yjs/yjs — GitHub',
    captureSource: 'browser-extension',
    metadata: {
      publisher: 'GitHub',
      stars: 17400,
      language: 'JavaScript',
      lastCommit: '2026-05-06'
    },
    createdAt: offsetISO(-1, 14),
    modifiedAt: offsetISO(-1, 14),
    tags: ['tech/sync', 'reference']
  },

  // ========================================================================
  // Snoozed link — Twitter/X thread
  // ========================================================================
  {
    id: id('lnk'),
    type: 'link',
    title: 'Thread on E2EE key rotation in messaging apps',
    content: 'Long thread, want to read with full attention.',
    sourceUrl: 'https://x.com/example/status/1234567890',
    captureSource: 'quick-capture',
    snoozedUntil: offsetISO(1, 9),
    snoozeReason: 'Read tomorrow with coffee, not while scrolling',
    metadata: { platform: 'x', authorHandle: '@cryptodev' },
    createdAt: offsetISO(-2, 22),
    modifiedAt: offsetISO(-2, 22),
    tags: ['tech/security']
  },

  // ========================================================================
  // Quick note — text capture
  // ========================================================================
  {
    id: id('nt'),
    type: 'note',
    title: 'Try Bun for the build pipeline',
    content:
      'Could replace tsx + esbuild on the dev path. Worth a 30-minute spike before the next quarter.',
    captureSource: 'quick-capture',
    createdAt: offsetISO(0, 7),
    modifiedAt: offsetISO(0, 7),
    tags: ['idea', 'tech/build']
  },

  // ========================================================================
  // Voice memo with transcription
  // ========================================================================
  {
    id: id('vcr'),
    type: 'voice',
    title: 'Voice memo — 2026-05-07 22:14',
    content: 'Transcription pending review',
    transcription:
      'OK so the inbox suggestion thing — the model is too eager about the "linked" action. Need a confidence threshold of 0.7 minimum before we offer it as the default. Right now anything above 0.4 wins which is too low. Also Manny suggested we add a "no, just inbox" rejection bucket for training. Worth doing. Reminder me on Monday.',
    transcriptionStatus: 'complete',
    captureSource: 'quick-capture',
    attachmentPath: 'attachments/inbox/voice-2026-05-07.m4a',
    createdAt: offsetISO(-1, 22),
    modifiedAt: offsetISO(-1, 22),
    tags: ['projects/memry', 'inbox', 'ai']
  },

  // ========================================================================
  // Voice memo — second one
  // ========================================================================
  {
    id: id('vcr'),
    type: 'voice',
    title: 'Voice memo — Idea for Memry export',
    transcription:
      'For the v0.1 launch, we should let people export their entire vault as a zip with a pretty index.html. Not for sync, just for "I am leaving." That story matters more than the import story.',
    transcriptionStatus: 'complete',
    captureSource: 'quick-capture',
    attachmentPath: 'attachments/inbox/voice-2026-05-05.m4a',
    createdAt: offsetISO(-3, 21),
    modifiedAt: offsetISO(-3, 21),
    tags: ['projects/memry', 'export']
  },

  // ========================================================================
  // Image — screenshot from extension
  // ========================================================================
  {
    id: id('img'),
    type: 'image',
    title: 'Screenshot — calendar grid bug',
    content: 'All-day events overflow on Mondays when the week wraps. See if the gap is a tz issue.',
    captureSource: 'browser-extension',
    attachmentPath: 'attachments/inbox/screenshot-cal-bug.png',
    thumbnailPath: 'attachments/inbox/screenshot-cal-bug.thumb.png',
    metadata: { width: 1840, height: 1080 },
    createdAt: offsetISO(0, 9),
    modifiedAt: offsetISO(0, 9),
    tags: ['projects/memry', 'bug']
  },

  // ========================================================================
  // Research PDF
  // ========================================================================
  {
    id: id('pdf'),
    type: 'pdf',
    title: 'Local-First Software (Kleppmann et al, 2019)',
    content:
      "The paper that named the movement. Worth re-reading before the conference talk.",
    sourceUrl: 'https://www.inkandswitch.com/local-first/',
    captureSource: 'browser-extension',
    attachmentPath: 'attachments/inbox/local-first-software.pdf',
    metadata: { pages: 28, fileSize: 1830000 },
    createdAt: offsetISO(-4, 13),
    modifiedAt: offsetISO(-4, 13),
    tags: ['research', 'projects/memry']
  },

  // ========================================================================
  // Reminder — re-read item
  // ========================================================================
  {
    id: id('rmd'),
    type: 'reminder',
    title: 'Re-read Dune Chapter 3',
    content:
      'The Bene Gesserit "litany against fear" passage. The opening sequence. Want to see how Herbert structures the world-building.',
    captureSource: 'reminder',
    metadata: { sourceNoteId: 'reference-to-dune-note' },
    createdAt: offsetISO(-5, 9),
    modifiedAt: offsetISO(-5, 9),
    tags: ['reading', 'reminders']
  },

  // ========================================================================
  // Web clip with sourceTitle
  // ========================================================================
  {
    id: id('clp'),
    type: 'clip',
    title: 'Excerpt: "Productivity is the wrong god."',
    content:
      'Excerpt from an essay on Four Thousand Weeks. The line about "the productivity stack as denial of mortality" — worth pulling into [[Four Thousand Weeks]].',
    sourceUrl: 'https://example.com/essay/productivity-wrong-god',
    sourceTitle: 'Productivity is the wrong god — Substack',
    captureSource: 'browser-extension',
    metadata: { publisher: 'Substack', author: 'A. Banner' },
    createdAt: offsetISO(-2, 15),
    modifiedAt: offsetISO(-2, 15),
    tags: ['reading', 'reflection']
  },

  // ========================================================================
  // Filed link (filedAt set) — example of a processed item
  // ========================================================================
  {
    id: id('lnk'),
    type: 'link',
    title: 'Drizzle: Better SQL through stricter types',
    sourceUrl: 'https://example.com/drizzle-typed-sql',
    captureSource: 'browser-extension',
    filedAt: offsetISO(-3, 16),
    filedTo: 'notes/tech/Drizzle ORM.md',
    filedAction: 'note',
    metadata: { publisher: 'Engineering blog', readingTime: 8 },
    createdAt: offsetISO(-4, 11),
    modifiedAt: offsetISO(-3, 16),
    tags: ['tech/sql', 'reference']
  },

  // ========================================================================
  // Snoozed note with reason
  // ========================================================================
  {
    id: id('nt'),
    type: 'note',
    title: 'Look into Astro view transitions',
    content:
      'Could use this in the [[Blog Redesign]] migration. View transitions API + Astro.',
    captureSource: 'quick-capture',
    snoozedUntil: offsetISO(7, 9),
    snoozeReason: 'Pick up after the [[Memry Launch]] hits a quieter week',
    createdAt: offsetISO(-1, 11),
    modifiedAt: offsetISO(-1, 11),
    tags: ['idea', 'web']
  },

  // ========================================================================
  // Reddit social post
  // ========================================================================
  {
    id: id('soc'),
    type: 'social',
    title: 'Reddit — what programming book changed your career?',
    content:
      'Long thread. Skimming for candidates beyond [[On Writing]] and [[Atomic Habits]] which I already have.',
    sourceUrl: 'https://reddit.com/r/programming/comments/abcdefg/',
    sourceTitle: 'r/programming — what programming book changed your career?',
    captureSource: 'browser-extension',
    metadata: { platform: 'reddit', upvotes: 1820, comments: 432 },
    createdAt: offsetISO(0, 12),
    modifiedAt: offsetISO(0, 12),
    tags: ['reading', 'idea']
  },

  // ========================================================================
  // Article link — long content excerpt
  // ========================================================================
  {
    id: id('lnk'),
    type: 'link',
    title: 'On the Use and Misuse of Synthetic Data',
    content:
      'Long-form piece on training-data ethics. Worth keeping for the [[Memry GTM]] conversation around what we do (and don\'t) collect.',
    sourceUrl: 'https://example.com/synthetic-data-essay',
    sourceTitle: 'On the Use and Misuse of Synthetic Data',
    captureSource: 'browser-extension',
    metadata: { author: 'L. Yu', readingTime: 22 },
    createdAt: offsetISO(-2, 9),
    modifiedAt: offsetISO(-2, 9),
    tags: ['tech/ai', 'ethics']
  },

  // ========================================================================
  // Old archived item
  // ========================================================================
  {
    id: id('nt'),
    type: 'note',
    title: 'Old idea — meeting cost calculator',
    content: 'Did this already, didn\'t ship. Archived.',
    captureSource: 'quick-capture',
    archivedAt: offsetISO(-95, 18),
    createdAt: offsetISO(-180, 11),
    modifiedAt: offsetISO(-95, 18),
    tags: ['idea']
  }
]

export const FILING_HISTORY_ROWS: SeedFilingHistory[] = [
  {
    id: generateId(),
    itemType: 'link',
    itemContent: 'Drizzle: Better SQL through stricter types — engineering blog post on type-safe ORM',
    filedTo: 'notes/tech/Drizzle ORM.md',
    filedAction: 'note',
    tags: ['tech/sql', 'reference'],
    filedAt: offsetISO(-3, 16)
  },
  {
    id: generateId(),
    itemType: 'link',
    itemContent: 'Yjs deep dive — collaborative editing internals',
    filedTo: 'notes/tech/CRDT Architecture.md',
    filedAction: 'note',
    tags: ['tech/sync', 'reference'],
    filedAt: offsetISO(-9, 14)
  },
  {
    id: generateId(),
    itemType: 'note',
    itemContent: 'Idea: lazy-load graph view past 500 nodes',
    filedTo: 'notes/projects/Memry Launch.md',
    filedAction: 'note',
    tags: ['projects/memry', 'perf'],
    filedAt: offsetISO(-15, 11)
  }
]
