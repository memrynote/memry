import { generateId } from '../../src/main/lib/id'
import type { SeedTagCategory, SeedTagDefinition } from '../seed-vault/db-writer'

// ============================================================================
// Tag palette.
//
// Every tag the seeded notes, journal entries, tasks and inbox items actually
// use gets a definition and a category, so the tag hub and the sidebar tag tree
// open on a full, colored, grouped list instead of a wall of grey defaults.
// A handful stay uncategorized on purpose — the Uncategorized bucket has to
// look real too.
// ============================================================================

const CATEGORY_IDS = {
  engineering: generateId(),
  projects: generateId(),
  reading: generateId(),
  watching: generateId(),
  travel: generateId(),
  health: generateId(),
  life: generateId(),
  work: generateId()
} as const

export const TAG_CATEGORIES: SeedTagCategory[] = [
  { id: CATEGORY_IDS.engineering, name: 'Engineering', sortOrder: 0 },
  { id: CATEGORY_IDS.projects, name: 'Projects', sortOrder: 1 },
  { id: CATEGORY_IDS.reading, name: 'Reading', sortOrder: 2 },
  { id: CATEGORY_IDS.watching, name: 'Watching', sortOrder: 3 },
  { id: CATEGORY_IDS.travel, name: 'Travel', sortOrder: 4 },
  { id: CATEGORY_IDS.health, name: 'Health', sortOrder: 5 },
  { id: CATEGORY_IDS.life, name: 'Life', sortOrder: 6 },
  { id: CATEGORY_IDS.work, name: 'Work', sortOrder: 7 }
]

/** `[name, color]` pairs, listed in the order they should appear in a group. */
type TagEntry = [name: string, color: string]

const GROUPS: Array<{ categoryId: string; tags: TagEntry[] }> = [
  {
    categoryId: CATEGORY_IDS.engineering,
    tags: [
      ['tech/typescript', '#0ea5e9'],
      ['tech/rust', '#dc2626'],
      ['tech/sql', '#a855f7'],
      ['tech/postgres', '#0284c7'],
      ['tech/python', '#22c55e'],
      ['tech/sync', '#22c55e'],
      ['tech/electron', '#9333ea'],
      ['tech/architecture', '#6366f1'],
      ['tech/embeddings', '#8b5cf6'],
      ['tech/docker', '#0891b2'],
      ['tech/git', '#f97316'],
      ['tech/editor', '#14b8a6'],
      ['tech/physics', '#64748b'],
      ['architecture', '#6366f1'],
      ['sync', '#22c55e'],
      ['rust', '#dc2626'],
      ['web', '#0ea5e9'],
      ['perf', '#ef4444'],
      ['tests', '#10b981'],
      ['tooling', '#64748b'],
      ['ai', '#8b5cf6'],
      ['ios', '#0f172a'],
      ['android', '#22c55e'],
      ['mobile', '#14b8a6'],
      ['oss', '#f59e0b']
    ]
  },
  {
    categoryId: CATEGORY_IDS.projects,
    tags: [
      ['projects/memry', '#6366f1'],
      ['projects/active', '#14b8a6'],
      ['projects/personal', '#f97316'],
      ['projects/home', '#84cc16'],
      ['launch', '#ef4444'],
      ['gtm', '#f59e0b'],
      ['side-projects', '#8b5cf6'],
      ['renovation', '#a16207'],
      ['garden', '#65a30d'],
      ['pr', '#0ea5e9'],
      ['speaking', '#d946ef'],
      ['ideas', '#facc15']
    ]
  },
  {
    categoryId: CATEGORY_IDS.reading,
    tags: [
      ['reading', '#f59e0b'],
      ['fiction', '#f59e0b'],
      ['nonfiction', '#ec4899'],
      ['sci-fi', '#8b5cf6'],
      ['classic', '#a855f7'],
      ['memoir', '#d97706'],
      ['mystery', '#0d9488'],
      ['cozy', '#f472b6'],
      ['philosophy', '#7c3aed'],
      ['history', '#b45309'],
      ['big-ideas', '#6366f1'],
      ['craft', '#0891b2'],
      ['reread', '#0ea5e9'],
      ['favorites', '#f59e0b'],
      ['andy-weir', '#64748b']
    ]
  },
  {
    categoryId: CATEGORY_IDS.watching,
    tags: [
      ['movies', '#ec4899'],
      ['movies/sci-fi', '#8b5cf6'],
      ['movies/scifi', '#8b5cf6'],
      ['movies/drama', '#f43f5e'],
      ['movies/crime', '#b91c1c'],
      ['movies/animation', '#22d3ee'],
      ['rewatch', '#a855f7'],
      ['watchlist', '#6b7280'],
      ['foreign', '#0ea5e9'],
      ['absurd', '#f97316'],
      ['a24', '#111827'],
      ['star-wars', '#facc15'],
      ['studio-ghibli', '#34d399'],
      ['christopher-nolan', '#475569'],
      ['denis-villeneuve', '#475569'],
      ['ridley-scott', '#475569'],
      ['bong-joon-ho', '#475569'],
      ['scorsese', '#475569'],
      ['wachowski', '#475569']
    ]
  },
  {
    categoryId: CATEGORY_IDS.travel,
    tags: [
      ['travel', '#f97316'],
      ['travel/asia', '#f97316'],
      ['travel/europe', '#0ea5e9'],
      ['travel/japan', '#ef4444'],
      ['travel/korea', '#3b82f6'],
      ['travel/portugal', '#16a34a'],
      ['travel/iceland', '#06b6d4'],
      ['travel/mexico', '#eab308'],
      ['travel/americas', '#f43f5e'],
      ['tokyo', '#ef4444'],
      ['kyoto', '#dc2626'],
      ['istanbul', '#0ea5e9'],
      ['city-break', '#22c55e'],
      ['weekend', '#84cc16'],
      ['food', '#e11d48'],
      ['coffee', '#a16207'],
      ['museum', '#8b5cf6'],
      ['art', '#d946ef'],
      ['ferry', '#0891b2'],
      ['packing', '#64748b'],
      ['logistics', '#6b7280'],
      ['goodbye', '#94a3b8']
    ]
  },
  {
    categoryId: CATEGORY_IDS.health,
    tags: [
      ['fitness', '#84cc16'],
      ['cut', '#65a30d'],
      ['lift', '#16a34a'],
      ['strength', '#15803d'],
      ['cardio', '#f97316'],
      ['nutrition', '#e11d48'],
      ['health', '#10b981'],
      ['tracking', '#0ea5e9'],
      ['log', '#6b7280'],
      ['annual', '#94a3b8']
    ]
  },
  {
    categoryId: CATEGORY_IDS.life,
    tags: [
      ['daily', '#6366f1'],
      ['reflection', '#a855f7'],
      ['gratitude', '#f59e0b'],
      ['joy', '#fbbf24'],
      ['mission', '#ef4444'],
      ['mortality', '#475569'],
      ['people', '#0ea5e9'],
      ['family', '#f472b6'],
      ['friends', '#22c55e'],
      ['life', '#14b8a6'],
      ['money', '#16a34a'],
      ['wealth', '#65a30d'],
      ['learning', '#8b5cf6'],
      ['thoughtful', '#7c3aed'],
      ['habits', '#0891b2'],
      ['shopping', '#ec4899'],
      ['errands', '#f97316'],
      ['reminders', '#6b7280'],
      ['admin', '#94a3b8']
    ]
  },
  {
    categoryId: CATEGORY_IDS.work,
    tags: [
      ['work', '#6366f1'],
      ['writing', '#0ea5e9'],
      ['planning', '#8b5cf6'],
      ['meetings', '#94a3b8'],
      ['flow', '#10b981'],
      ['focus', '#14b8a6'],
      ['productivity', '#22c55e'],
      ['tasks', '#f59e0b'],
      ['inbox', '#6b7280'],
      ['calendar', '#3b82f6'],
      ['recurring', '#64748b'],
      ['reference', '#a1a1aa'],
      ['low-energy', '#a8a29e'],
      ['jetlag', '#78716c']
    ]
  }
]

// Uncategorized on purpose — the sidebar and tag hub both need a populated
// Uncategorized bucket to look like a real vault.
const UNCATEGORIZED: TagEntry[] = [
  ['research', '#3b82f6'],
  ['active', '#10b981'],
  ['archive', '#6b7280']
]

export const TAG_PALETTE: SeedTagDefinition[] = [
  ...GROUPS.flatMap(({ categoryId, tags }) =>
    tags.map(([name, color], index) => ({ name, color, categoryId, sortOrder: index }))
  ),
  ...UNCATEGORIZED.map(([name, color]) => ({ name, color }))
]
