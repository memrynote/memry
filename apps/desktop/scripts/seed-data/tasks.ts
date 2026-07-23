import { generateId } from '../../src/main/lib/id'
import { NOTE_IDS } from './notes'
import type {
  SeedProject,
  SeedStatus,
  SeedTask,
  SeedTaskNote,
  SeedTaskTag
} from '../seed-vault/db-writer'
import { seedDateOnly, seedISOAt } from './date'

const dateOffset = (days: number): string => {
  return seedDateOnly(days)
}

const datetimeOffset = (days: number, hours = 12): string => {
  return seedISOAt(days, hours)
}

// ============================================================================
// Project + Status IDs
// ============================================================================

export const PROJECT_IDS = {
  inbox: generateId(),
  istanbulWeekend: generateId(),
  memry: generateId(),
  reading: generateId(),
  fitness: generateId(),
  tokyo: generateId(),
  side: generateId()
} as const

const STATUS_IDS = {
  // Inbox
  inboxTodo: generateId(),
  // Istanbul Weekend
  istanbulPlan: generateId(),
  istanbulBooked: generateId(),
  istanbulToday: generateId(),
  istanbulDone: generateId(),
  // memrynote
  memryBacklog: generateId(),
  memryDoing: generateId(),
  memryReview: generateId(),
  memryDone: generateId(),
  // Reading
  readingWant: generateId(),
  readingReading: generateId(),
  readingDone: generateId(),
  // Fitness
  fitnessToday: generateId(),
  fitnessUpcoming: generateId(),
  fitnessDone: generateId(),
  // Tokyo
  tokyoPlanning: generateId(),
  tokyoBooked: generateId(),
  tokyoDone: generateId(),
  // Side
  sideIdea: generateId(),
  sideBuilding: generateId(),
  sideShipped: generateId()
} as const

// ============================================================================
// Projects
// ============================================================================

export const PROJECTS: SeedProject[] = [
  {
    id: PROJECT_IDS.inbox,
    name: 'Inbox',
    description: 'Quick capture, no project assigned yet.',
    color: '#6b7280',
    icon: '📥',
    position: 0,
    isInbox: true
  },
  {
    id: PROJECT_IDS.memry,
    name: 'memrynote Launch',
    description: 'Ship memrynote v0.1 to ~50 friends + IndieHackers.',
    color: '#6366f1',
    icon: '🚀',
    position: 2,
    homeNoteId: NOTE_IDS.projMemryLaunch
  },
  {
    id: PROJECT_IDS.istanbulWeekend,
    name: 'Istanbul Weekend',
    description: 'Plan a three-day Istanbul weekend with bookings, packing, food, and memories.',
    color: '#0ea5e9',
    icon: '🌉',
    position: 1,
    homeNoteId: NOTE_IDS.travelIstanbul
  },
  {
    id: PROJECT_IDS.reading,
    name: 'Reading',
    description: '2026 reading queue and finished list.',
    color: '#f59e0b',
    icon: '📚',
    position: 3,
    homeNoteId: NOTE_IDS.lifeOnReading
  },
  {
    id: PROJECT_IDS.fitness,
    name: 'Fitness 2026',
    description: 'Cut, train, sleep, repeat.',
    color: '#10b981',
    icon: '💪',
    position: 4,
    homeNoteId: NOTE_IDS.weightCut2026
  },
  {
    id: PROJECT_IDS.tokyo,
    name: 'Travel: Tokyo',
    description: 'April 2026 Tokyo trip — past, mostly closed out.',
    color: '#ec4899',
    icon: '🗼',
    position: 5,
    homeNoteId: NOTE_IDS.travelTokyoTrip
  },
  {
    id: PROJECT_IDS.side,
    name: 'Side Projects',
    description: 'Personal experiments, half-baked, sometimes shipped.',
    color: '#8b5cf6',
    icon: '✨',
    position: 6,
    homeNoteId: NOTE_IDS.projSideProjectIdeas
  }
]

// ============================================================================
// Statuses
// ============================================================================

export const STATUSES: SeedStatus[] = [
  // Inbox
  {
    id: STATUS_IDS.inboxTodo,
    projectId: PROJECT_IDS.inbox,
    name: 'To Do',
    color: '#6b7280',
    position: 0,
    isDefault: true
  },
  // Istanbul Weekend
  {
    id: STATUS_IDS.istanbulPlan,
    projectId: PROJECT_IDS.istanbulWeekend,
    name: 'Plan',
    color: '#94a3b8',
    position: 0,
    isDefault: true
  },
  {
    id: STATUS_IDS.istanbulBooked,
    projectId: PROJECT_IDS.istanbulWeekend,
    name: 'Booked',
    color: '#0ea5e9',
    position: 1
  },
  {
    id: STATUS_IDS.istanbulToday,
    projectId: PROJECT_IDS.istanbulWeekend,
    name: 'Today',
    color: '#f59e0b',
    position: 2
  },
  {
    id: STATUS_IDS.istanbulDone,
    projectId: PROJECT_IDS.istanbulWeekend,
    name: 'Done',
    color: '#10b981',
    position: 3,
    isDone: true
  },
  // memrynote
  {
    id: STATUS_IDS.memryBacklog,
    projectId: PROJECT_IDS.memry,
    name: 'Backlog',
    color: '#94a3b8',
    position: 0,
    isDefault: true
  },
  {
    id: STATUS_IDS.memryDoing,
    projectId: PROJECT_IDS.memry,
    name: 'Doing',
    color: '#6366f1',
    position: 1
  },
  {
    id: STATUS_IDS.memryReview,
    projectId: PROJECT_IDS.memry,
    name: 'Review',
    color: '#f59e0b',
    position: 2
  },
  {
    id: STATUS_IDS.memryDone,
    projectId: PROJECT_IDS.memry,
    name: 'Done',
    color: '#10b981',
    position: 3,
    isDone: true
  },
  // Reading
  {
    id: STATUS_IDS.readingWant,
    projectId: PROJECT_IDS.reading,
    name: 'Want to Read',
    color: '#94a3b8',
    position: 0,
    isDefault: true
  },
  {
    id: STATUS_IDS.readingReading,
    projectId: PROJECT_IDS.reading,
    name: 'Reading',
    color: '#f59e0b',
    position: 1
  },
  {
    id: STATUS_IDS.readingDone,
    projectId: PROJECT_IDS.reading,
    name: 'Done',
    color: '#10b981',
    position: 2,
    isDone: true
  },
  // Fitness
  {
    id: STATUS_IDS.fitnessToday,
    projectId: PROJECT_IDS.fitness,
    name: 'Today',
    color: '#ef4444',
    position: 0,
    isDefault: true
  },
  {
    id: STATUS_IDS.fitnessUpcoming,
    projectId: PROJECT_IDS.fitness,
    name: 'Upcoming',
    color: '#f59e0b',
    position: 1
  },
  {
    id: STATUS_IDS.fitnessDone,
    projectId: PROJECT_IDS.fitness,
    name: 'Done',
    color: '#10b981',
    position: 2,
    isDone: true
  },
  // Tokyo
  {
    id: STATUS_IDS.tokyoPlanning,
    projectId: PROJECT_IDS.tokyo,
    name: 'Planning',
    color: '#94a3b8',
    position: 0,
    isDefault: true
  },
  {
    id: STATUS_IDS.tokyoBooked,
    projectId: PROJECT_IDS.tokyo,
    name: 'Booked',
    color: '#f59e0b',
    position: 1
  },
  {
    id: STATUS_IDS.tokyoDone,
    projectId: PROJECT_IDS.tokyo,
    name: 'Done',
    color: '#10b981',
    position: 2,
    isDone: true
  },
  // Side
  {
    id: STATUS_IDS.sideIdea,
    projectId: PROJECT_IDS.side,
    name: 'Idea',
    color: '#94a3b8',
    position: 0,
    isDefault: true
  },
  {
    id: STATUS_IDS.sideBuilding,
    projectId: PROJECT_IDS.side,
    name: 'Building',
    color: '#8b5cf6',
    position: 1
  },
  {
    id: STATUS_IDS.sideShipped,
    projectId: PROJECT_IDS.side,
    name: 'Shipped',
    color: '#10b981',
    position: 2,
    isDone: true
  }
]

// ============================================================================
// Tasks
// ============================================================================

interface TaskBuilder {
  key: string
  projectId: string
  statusId: string
  title: string
  description?: string
  priority?: number
  dueDate?: string
  dueTime?: string
  startDate?: string
  repeatConfig?: Record<string, unknown> | null
  repeatFrom?: string | null
  sourceNoteId?: string | null
  parentKey?: string | null
  completedAt?: string | null
  tags?: string[]
  noteRefs?: string[]
}

const TASK_BUILDERS: TaskBuilder[] = [
  // ========================================================================
  // Inbox project — the catch-all
  // ========================================================================
  {
    key: 'inbox-call-mom',
    projectId: PROJECT_IDS.inbox,
    statusId: STATUS_IDS.inboxTodo,
    title: 'Call Mom about birthday plans',
    priority: 1,
    dueDate: dateOffset(2),
    tags: ['family']
  },
  {
    key: 'inbox-renew-license',
    projectId: PROJECT_IDS.inbox,
    statusId: STATUS_IDS.inboxTodo,
    title: 'Renew driver license',
    description: 'Online renewal — needs the old card number.',
    priority: 2,
    dueDate: dateOffset(14),
    tags: ['admin']
  },
  {
    key: 'inbox-dentist',
    projectId: PROJECT_IDS.inbox,
    statusId: STATUS_IDS.inboxTodo,
    title: 'Book dentist cleaning',
    priority: 1,
    dueDate: dateOffset(7),
    tags: ['health']
  },
  {
    key: 'inbox-followup',
    projectId: PROJECT_IDS.inbox,
    statusId: STATUS_IDS.inboxTodo,
    title: 'Follow up with M. about coffee Saturday',
    priority: 1,
    dueDate: dateOffset(1),
    tags: ['friends']
  },
  {
    key: 'inbox-tax-docs',
    projectId: PROJECT_IDS.inbox,
    statusId: STATUS_IDS.inboxTodo,
    title: 'File 2025 tax extension paperwork',
    priority: 3,
    dueDate: dateOffset(-3), // overdue
    tags: ['admin']
  },

  // ========================================================================
  // Istanbul Weekend
  // ========================================================================
  {
    key: 'istanbul-plan-weekend',
    projectId: PROJECT_IDS.istanbulWeekend,
    statusId: STATUS_IDS.istanbulToday,
    title: 'Plan Istanbul weekend',
    description: 'Keep the trip simple: ferry, food, one museum, and room to wander.',
    priority: 3,
    dueDate: dateOffset(0),
    dueTime: '20:00',
    sourceNoteId: NOTE_IDS.travelIstanbul,
    tags: ['travel', 'istanbul', 'planning'],
    noteRefs: [NOTE_IDS.travelIstanbul]
  },
  {
    key: 'istanbul-ferry-plan',
    projectId: PROJECT_IDS.istanbulWeekend,
    statusId: STATUS_IDS.istanbulBooked,
    title: 'Confirm Bosphorus ferry plan',
    description: 'Check Şehir Hatları times and save the evening route.',
    priority: 2,
    dueDate: dateOffset(0),
    dueTime: '09:30',
    parentKey: 'istanbul-plan-weekend',
    sourceNoteId: NOTE_IDS.travelIstanbul,
    tags: ['travel', 'istanbul', 'ferry'],
    noteRefs: [NOTE_IDS.travelIstanbul]
  },
  {
    key: 'istanbul-dinner',
    projectId: PROJECT_IDS.istanbulWeekend,
    statusId: STATUS_IDS.istanbulToday,
    title: 'Pick Kadıköy dinner spot',
    description: 'Choose one easy place and add it to the food notes.',
    priority: 2,
    dueDate: dateOffset(0),
    dueTime: '18:00',
    parentKey: 'istanbul-plan-weekend',
    sourceNoteId: NOTE_IDS.weightFoodDiary,
    tags: ['travel', 'istanbul', 'food'],
    noteRefs: [NOTE_IDS.travelIstanbul, NOTE_IDS.weightFoodDiary]
  },
  {
    key: 'istanbul-pack',
    projectId: PROJECT_IDS.istanbulWeekend,
    statusId: STATUS_IDS.istanbulPlan,
    title: 'Pack light layers and charger pouch',
    priority: 1,
    dueDate: dateOffset(1),
    parentKey: 'istanbul-plan-weekend',
    sourceNoteId: NOTE_IDS.travelPackingList,
    tags: ['travel', 'packing'],
    noteRefs: [NOTE_IDS.travelIstanbul, NOTE_IDS.travelPackingList]
  },
  {
    key: 'istanbul-hotel-address',
    projectId: PROJECT_IDS.istanbulWeekend,
    statusId: STATUS_IDS.istanbulDone,
    title: 'Save hotel address screenshot offline',
    priority: 1,
    completedAt: datetimeOffset(-1, 21),
    tags: ['travel', 'istanbul'],
    noteRefs: [NOTE_IDS.travelIstanbul]
  },
  {
    key: 'istanbul-airport-transfer',
    projectId: PROJECT_IDS.istanbulWeekend,
    statusId: STATUS_IDS.istanbulBooked,
    title: 'Book airport transfer',
    description: 'Late arrival, keep the first night friction-free.',
    priority: 2,
    startDate: dateOffset(0),
    dueDate: dateOffset(1),
    dueTime: '11:00',
    tags: ['travel', 'istanbul', 'logistics']
  },
  {
    key: 'istanbul-weather-ferry',
    projectId: PROJECT_IDS.istanbulWeekend,
    statusId: STATUS_IDS.istanbulToday,
    title: 'Check weather and ferry times',
    description: 'Morning check until the trip starts.',
    priority: 1,
    dueDate: dateOffset(0),
    dueTime: '08:30',
    repeatConfig: { freq: 'daily', until: dateOffset(2) },
    repeatFrom: 'due',
    tags: ['travel', 'istanbul', 'recurring'],
    noteRefs: [NOTE_IDS.travelIstanbul]
  },
  {
    key: 'istanbul-share-itinerary',
    projectId: PROJECT_IDS.istanbulWeekend,
    statusId: STATUS_IDS.istanbulToday,
    title: 'Share itinerary with Mina',
    priority: 1,
    dueDate: dateOffset(0),
    dueTime: '19:00',
    tags: ['travel', 'friends']
  },
  {
    key: 'istanbul-cistern-ticket',
    projectId: PROJECT_IDS.istanbulWeekend,
    statusId: STATUS_IDS.istanbulPlan,
    title: 'Add Basilica Cistern tickets to wallet',
    priority: 2,
    dueDate: dateOffset(2),
    sourceNoteId: NOTE_IDS.travelIstanbul,
    tags: ['travel', 'istanbul', 'museum'],
    noteRefs: [NOTE_IDS.travelIstanbul]
  },

  // ========================================================================
  // memrynote Launch
  // ========================================================================
  {
    key: 'memry-mobile-readonly',
    projectId: PROJECT_IDS.memry,
    statusId: STATUS_IDS.memryBacklog,
    title: 'Mobile read-only viewer',
    description: 'iOS + Android: open vault, read notes, tap wikilinks, zero edit.',
    priority: 2,
    dueDate: dateOffset(30),
    sourceNoteId: NOTE_IDS.projMemryRoadmap,
    tags: ['projects/memry', 'mobile'],
    noteRefs: [NOTE_IDS.projMemryLaunch, NOTE_IDS.projMemryRoadmap]
  },
  {
    key: 'memry-public-landing',
    projectId: PROJECT_IDS.memry,
    statusId: STATUS_IDS.memryDoing,
    title: 'Build public landing page',
    description: 'One page. Hero, three benefits, screenshot, waitlist.',
    priority: 3,
    dueDate: dateOffset(10),
    sourceNoteId: NOTE_IDS.projMemryGTM,
    tags: ['projects/memry', 'web', 'launch'],
    noteRefs: [NOTE_IDS.projMemryGTM, NOTE_IDS.projMemryLaunch]
  },
  {
    key: 'memry-pricing',
    projectId: PROJECT_IDS.memry,
    statusId: STATUS_IDS.memryDoing,
    title: 'Decide on pricing',
    description: 'Free + paid sync? One-time? Open source + hosted? Pick one.',
    priority: 3,
    dueDate: dateOffset(5),
    sourceNoteId: NOTE_IDS.projMemryGTM,
    tags: ['projects/memry', 'gtm']
  },
  {
    key: 'memry-launch-post',
    projectId: PROJECT_IDS.memry,
    statusId: STATUS_IDS.memryBacklog,
    title: 'Draft Hacker News launch post',
    priority: 2,
    dueDate: dateOffset(20),
    sourceNoteId: NOTE_IDS.projMemryGTM,
    tags: ['projects/memry', 'gtm', 'writing']
  },
  {
    key: 'memry-crdt-sync-v1',
    projectId: PROJECT_IDS.memry,
    statusId: STATUS_IDS.memryDone,
    title: 'CRDT sync v1',
    description: 'Yjs over the contract layer. End-to-end working between two devices.',
    priority: 3,
    completedAt: datetimeOffset(-12, 18),
    sourceNoteId: NOTE_IDS.techCRDTArchitecture,
    tags: ['projects/memry', 'sync'],
    noteRefs: [NOTE_IDS.techCRDTArchitecture, NOTE_IDS.projMemryArchitecture]
  },
  {
    key: 'memry-calendar-v1',
    projectId: PROJECT_IDS.memry,
    statusId: STATUS_IDS.memryDone,
    title: 'Calendar v1 (local + Google)',
    priority: 2,
    completedAt: datetimeOffset(-25, 14),
    sourceNoteId: NOTE_IDS.projMemryRoadmap,
    tags: ['projects/memry', 'calendar']
  },
  {
    key: 'memry-inbox-snooze',
    projectId: PROJECT_IDS.memry,
    statusId: STATUS_IDS.memryDone,
    title: 'Inbox snooze with reason',
    priority: 1,
    completedAt: datetimeOffset(-11, 11),
    tags: ['projects/memry', 'inbox']
  },
  {
    key: 'memry-inbox-suggestions',
    projectId: PROJECT_IDS.memry,
    statusId: STATUS_IDS.memryReview,
    title: 'Inbox AI filing suggestions',
    description: 'Suggest a destination folder + tags based on filing history.',
    priority: 2,
    dueDate: dateOffset(2),
    tags: ['projects/memry', 'inbox', 'ai']
  },
  {
    key: 'memry-graph-view-perf',
    projectId: PROJECT_IDS.memry,
    statusId: STATUS_IDS.memryBacklog,
    title: 'Graph view: lazy load > 500 nodes',
    description: 'Hits a wall around 800 notes. Force-atlas runs at 4 fps. Lazy load.',
    priority: 1,
    dueDate: dateOffset(35),
    tags: ['projects/memry', 'perf']
  },
  {
    key: 'memry-tasks-recurring',
    projectId: PROJECT_IDS.memry,
    statusId: STATUS_IDS.memryDoing,
    title: 'Recurring tasks: repeat-from-completed',
    description: 'When a recurring task is completed, schedule next from completion, not due date.',
    priority: 2,
    dueDate: dateOffset(7),
    tags: ['projects/memry', 'tasks']
  },
  {
    key: 'memry-conf-talk',
    projectId: PROJECT_IDS.memry,
    statusId: STATUS_IDS.memryBacklog,
    title: 'Prep LocalFirst Conf talk slides',
    priority: 2,
    dueDate: dateOffset(120),
    sourceNoteId: NOTE_IDS.projConferenceTalk,
    tags: ['projects/memry', 'speaking'],
    noteRefs: [NOTE_IDS.projConferenceTalk]
  },
  {
    key: 'memry-tests-e2e',
    projectId: PROJECT_IDS.memry,
    statusId: STATUS_IDS.memryDoing,
    title: 'Stabilize Playwright e2e suite in CI',
    description: 'Flaky on xvfb timing. Pre-built electron bundle is the fix.',
    priority: 1,
    dueDate: dateOffset(4),
    tags: ['projects/memry', 'tests']
  },

  // Subtask tree under "Mobile read-only viewer"
  {
    key: 'memry-mobile-iOS',
    projectId: PROJECT_IDS.memry,
    statusId: STATUS_IDS.memryBacklog,
    title: 'iOS — wrap WKWebView',
    priority: 2,
    dueDate: dateOffset(28),
    parentKey: 'memry-mobile-readonly',
    tags: ['projects/memry', 'mobile', 'ios']
  },
  {
    key: 'memry-mobile-android',
    projectId: PROJECT_IDS.memry,
    statusId: STATUS_IDS.memryBacklog,
    title: 'Android — wrap WebView',
    priority: 2,
    dueDate: dateOffset(35),
    parentKey: 'memry-mobile-readonly',
    tags: ['projects/memry', 'mobile', 'android']
  },
  {
    key: 'memry-mobile-bundle',
    projectId: PROJECT_IDS.memry,
    statusId: STATUS_IDS.memryBacklog,
    title: 'Mobile — shared bundle build pipeline',
    parentKey: 'memry-mobile-readonly',
    priority: 2,
    dueDate: dateOffset(15),
    tags: ['projects/memry', 'mobile', 'tooling']
  },

  // ========================================================================
  // Reading
  // ========================================================================
  {
    key: 'read-sapiens',
    projectId: PROJECT_IDS.reading,
    statusId: STATUS_IDS.readingReading,
    title: 'Finish reading Sapiens',
    priority: 1,
    dueDate: dateOffset(21),
    sourceNoteId: NOTE_IDS.bookSapiens,
    tags: ['reading', 'nonfiction'],
    noteRefs: [NOTE_IDS.bookSapiens]
  },
  {
    key: 'read-mystery-guest',
    projectId: PROJECT_IDS.reading,
    statusId: STATUS_IDS.readingReading,
    title: 'Finish The Mystery Guest',
    priority: 0,
    dueDate: dateOffset(7),
    sourceNoteId: NOTE_IDS.bookMisteryHotel,
    tags: ['reading', 'fiction'],
    noteRefs: [NOTE_IDS.bookMisteryHotel]
  },
  {
    key: 'read-naval',
    projectId: PROJECT_IDS.reading,
    statusId: STATUS_IDS.readingReading,
    title: 'Finish The Almanack of Naval Ravikant',
    priority: 0,
    dueDate: dateOffset(14),
    sourceNoteId: NOTE_IDS.bookAlmanackOfNaval,
    tags: ['reading', 'nonfiction'],
    noteRefs: [NOTE_IDS.bookAlmanackOfNaval]
  },
  {
    key: 'read-dune-messiah',
    projectId: PROJECT_IDS.reading,
    statusId: STATUS_IDS.readingWant,
    title: 'Read Dune Messiah',
    description: 'Sequel to [[Dune]]. Heard it splits the fanbase.',
    priority: 0,
    sourceNoteId: NOTE_IDS.bookDune,
    tags: ['reading', 'fiction', 'sci-fi'],
    noteRefs: [NOTE_IDS.bookDune]
  },
  {
    key: 'read-borders',
    projectId: PROJECT_IDS.reading,
    statusId: STATUS_IDS.readingWant,
    title: 'Read All the Light We Cannot See',
    priority: 0,
    tags: ['reading', 'fiction']
  },
  {
    key: 'read-hailmary-done',
    projectId: PROJECT_IDS.reading,
    statusId: STATUS_IDS.readingDone,
    title: 'Read Project Hail Mary',
    completedAt: datetimeOffset(-22, 21),
    sourceNoteId: NOTE_IDS.bookProjectHailMary,
    tags: ['reading', 'fiction', 'sci-fi'],
    noteRefs: [NOTE_IDS.bookProjectHailMary]
  },
  {
    key: 'read-4kweeks-done',
    projectId: PROJECT_IDS.reading,
    statusId: STATUS_IDS.readingDone,
    title: 'Read Four Thousand Weeks',
    completedAt: datetimeOffset(-90, 22),
    sourceNoteId: NOTE_IDS.bookFourThousandWeeks,
    tags: ['reading', 'nonfiction'],
    noteRefs: [NOTE_IDS.bookFourThousandWeeks]
  },
  {
    key: 'read-onwriting-done',
    projectId: PROJECT_IDS.reading,
    statusId: STATUS_IDS.readingDone,
    title: 'Read On Writing',
    completedAt: datetimeOffset(-180, 22),
    sourceNoteId: NOTE_IDS.bookOnWriting,
    tags: ['reading', 'nonfiction', 'craft']
  },

  // ========================================================================
  // Fitness 2026
  // ========================================================================
  {
    key: 'fit-weighin',
    projectId: PROJECT_IDS.fitness,
    statusId: STATUS_IDS.fitnessToday,
    title: 'Sunday weigh-in',
    description: 'Sunday morning, after the bathroom, before water. Update [[Cutting Log]].',
    priority: 1,
    dueDate: dateOffset(2),
    repeatConfig: { freq: 'weekly', byDay: 'SU' },
    repeatFrom: 'due',
    sourceNoteId: NOTE_IDS.weightSundayWeighIn,
    tags: ['fitness', 'recurring'],
    noteRefs: [NOTE_IDS.weightSundayWeighIn, NOTE_IDS.weightCuttingLog]
  },
  {
    key: 'fit-lower-mon',
    projectId: PROJECT_IDS.fitness,
    statusId: STATUS_IDS.fitnessToday,
    title: 'Lower (Squat day)',
    description: '5×5 back squat, 4×8 RDL, 3×10 walking lunges.',
    priority: 1,
    dueDate: dateOffset(3),
    sourceNoteId: NOTE_IDS.weightTrainingSplit,
    tags: ['fitness', 'lift'],
    noteRefs: [NOTE_IDS.weightTrainingSplit]
  },
  {
    key: 'fit-cardio-wed',
    projectId: PROJECT_IDS.fitness,
    statusId: STATUS_IDS.fitnessUpcoming,
    title: 'Zone 2 cardio (30 min)',
    priority: 0,
    dueDate: dateOffset(5),
    sourceNoteId: NOTE_IDS.weightCardioPlan,
    tags: ['fitness', 'cardio']
  },
  {
    key: 'fit-meal-prep',
    projectId: PROJECT_IDS.fitness,
    statusId: STATUS_IDS.fitnessUpcoming,
    title: 'Sunday meal prep',
    priority: 1,
    dueDate: dateOffset(2),
    sourceNoteId: NOTE_IDS.weightProteinTargets,
    tags: ['fitness', 'food'],
    noteRefs: [NOTE_IDS.weightProteinTargets]
  },
  {
    key: 'fit-progress-photo',
    projectId: PROJECT_IDS.fitness,
    statusId: STATUS_IDS.fitnessUpcoming,
    title: 'Friday progress photos',
    priority: 0,
    dueDate: dateOffset(7),
    sourceNoteId: NOTE_IDS.weightProgressPhotos,
    tags: ['fitness', 'tracking']
  },
  {
    key: 'fit-overdue',
    projectId: PROJECT_IDS.fitness,
    statusId: STATUS_IDS.fitnessToday,
    title: 'Refill creatine',
    priority: 0,
    dueDate: dateOffset(-2),
    tags: ['fitness']
  },
  {
    key: 'fit-done-1',
    projectId: PROJECT_IDS.fitness,
    statusId: STATUS_IDS.fitnessDone,
    title: 'Last week — completed split',
    completedAt: datetimeOffset(-5, 19),
    tags: ['fitness']
  },
  {
    key: 'fit-done-2',
    projectId: PROJECT_IDS.fitness,
    statusId: STATUS_IDS.fitnessDone,
    title: 'Squat 140kg × 5 (PR)',
    completedAt: datetimeOffset(-27, 18),
    tags: ['fitness', 'pr']
  },

  // ========================================================================
  // Travel: Tokyo
  // ========================================================================
  {
    key: 'tokyo-flight-booked',
    projectId: PROJECT_IDS.tokyo,
    statusId: STATUS_IDS.tokyoDone,
    title: 'Book flights',
    completedAt: datetimeOffset(-90, 14),
    sourceNoteId: NOTE_IDS.travelTokyoTrip,
    tags: ['travel/japan'],
    noteRefs: [NOTE_IDS.travelTokyoTrip]
  },
  {
    key: 'tokyo-hotel',
    projectId: PROJECT_IDS.tokyo,
    statusId: STATUS_IDS.tokyoDone,
    title: 'Book hotel (Park Hyatt)',
    completedAt: datetimeOffset(-85, 11),
    sourceNoteId: NOTE_IDS.travelTokyoTrip,
    tags: ['travel/japan']
  },
  {
    key: 'tokyo-jr-pass',
    projectId: PROJECT_IDS.tokyo,
    statusId: STATUS_IDS.tokyoDone,
    title: 'JR Pass (7-day)',
    completedAt: datetimeOffset(-50, 9),
    tags: ['travel/japan']
  },
  {
    key: 'tokyo-kyoto-day',
    projectId: PROJECT_IDS.tokyo,
    statusId: STATUS_IDS.tokyoDone,
    title: 'Day trip — Kyoto',
    completedAt: datetimeOffset(-23, 21),
    sourceNoteId: NOTE_IDS.travelKyotoDayTrip,
    tags: ['travel/japan'],
    noteRefs: [NOTE_IDS.travelKyotoDayTrip]
  },
  {
    key: 'tokyo-cafes-list',
    projectId: PROJECT_IDS.tokyo,
    statusId: STATUS_IDS.tokyoDone,
    title: 'Coffee crawl',
    completedAt: datetimeOffset(-21, 17),
    sourceNoteId: NOTE_IDS.travelTokyoCafes,
    tags: ['travel/japan', 'coffee'],
    noteRefs: [NOTE_IDS.travelTokyoCafes]
  },
  {
    key: 'tokyo-thank-you',
    projectId: PROJECT_IDS.tokyo,
    statusId: STATUS_IDS.tokyoBooked,
    title: 'Send thank-you note to host',
    priority: 1,
    dueDate: dateOffset(3),
    tags: ['travel/japan', 'gratitude']
  },

  // ========================================================================
  // Side Projects
  // ========================================================================
  {
    key: 'side-csv-graph',
    projectId: PROJECT_IDS.side,
    statusId: STATUS_IDS.sideIdea,
    title: 'CSV → opinionated chart',
    description: 'Drop a CSV, get one chart, no config. Chart picks itself.',
    priority: 0,
    sourceNoteId: NOTE_IDS.projSideProjectIdeas,
    tags: ['side-projects'],
    noteRefs: [NOTE_IDS.projSideProjectIdeas]
  },
  {
    key: 'side-espresso-log',
    projectId: PROJECT_IDS.side,
    statusId: STATUS_IDS.sideIdea,
    title: 'Espresso log app',
    description: 'Niche, mine, local-first. Track shots, dose, ratio, dial-in journal.',
    priority: 0,
    sourceNoteId: NOTE_IDS.projSideProjectIdeas,
    tags: ['side-projects', 'coffee']
  },
  {
    key: 'side-blog-redesign',
    projectId: PROJECT_IDS.side,
    statusId: STATUS_IDS.sideBuilding,
    title: 'Blog redesign — migrate to Astro',
    priority: 1,
    dueDate: dateOffset(38),
    sourceNoteId: NOTE_IDS.projBlogRedesign,
    tags: ['side-projects', 'web'],
    noteRefs: [NOTE_IDS.projBlogRedesign]
  },
  {
    key: 'side-rust-cli',
    projectId: PROJECT_IDS.side,
    statusId: STATUS_IDS.sideBuilding,
    title: 'Rust CLI for vault stats',
    description: 'A vault-stats binary in Rust — note count, word count, link density.',
    priority: 0,
    dueDate: dateOffset(50),
    sourceNoteId: NOTE_IDS.techRustNotes,
    tags: ['side-projects', 'rust'],
    noteRefs: [NOTE_IDS.techRustNotes]
  },
  {
    key: 'side-shipped-1',
    projectId: PROJECT_IDS.side,
    statusId: STATUS_IDS.sideShipped,
    title: 'Anti-newsletter MVP',
    description: 'Shipped to 3 users. They liked it. Did not scale.',
    completedAt: datetimeOffset(-200, 18),
    tags: ['side-projects']
  },
  {
    key: 'side-shipped-2',
    projectId: PROJECT_IDS.side,
    statusId: STATUS_IDS.sideShipped,
    title: 'Calendar diff tool',
    completedAt: datetimeOffset(-310, 12),
    tags: ['side-projects']
  }
]

// Resolve task IDs and parent links
const taskIdByKey = new Map<string, string>(TASK_BUILDERS.map((b) => [b.key, generateId()]))

export const TASKS: SeedTask[] = TASK_BUILDERS.map((b, idx) => ({
  id: taskIdByKey.get(b.key)!,
  projectId: b.projectId,
  statusId: b.statusId,
  parentId: b.parentKey ? taskIdByKey.get(b.parentKey)! : null,
  title: b.title,
  description: b.description ?? null,
  priority: b.priority ?? 0,
  position: idx,
  dueDate: b.dueDate ?? null,
  dueTime: b.dueTime ?? null,
  startDate: b.startDate ?? null,
  repeatConfig: b.repeatConfig ?? null,
  repeatFrom: b.repeatFrom ?? null,
  sourceNoteId: b.sourceNoteId ?? null,
  completedAt: b.completedAt ?? null
}))

export const TASK_NOTES: SeedTaskNote[] = TASK_BUILDERS.flatMap((b) => {
  const taskId = taskIdByKey.get(b.key)!
  return (b.noteRefs ?? []).map((noteId) => ({ taskId, noteId }))
})

export const TASK_TAGS: SeedTaskTag[] = TASK_BUILDERS.flatMap((b) => {
  const taskId = taskIdByKey.get(b.key)!
  return (b.tags ?? []).map((tag) => ({ taskId, tag }))
})
