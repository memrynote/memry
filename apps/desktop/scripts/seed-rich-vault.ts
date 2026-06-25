#!/usr/bin/env npx tsx
/**
 * Seed a RICH demo vault: notes, journals, tags, properties, calendar events,
 * tasks, projects, inbox items, home widgets (one of every kind) — with icons
 * on tags, folders and notes.
 *
 * Strategy: notes/journals are markdown files (the app's indexer builds the
 * search/index.db on first open and pulls `emoji`/tags/properties straight from
 * frontmatter, so we never touch index.db). Everything that isn't derivable
 * from a file — folder icons, tag colors/icons, the property schema, tasks,
 * projects, calendar, inbox, the home board, bookmarks — goes into data.db.
 *
 * Usage:
 *   pnpm --filter @memry/desktop seed:rich            # ~/MemryRichVault
 *   pnpm --filter @memry/desktop seed:rich -- --vault=/path --force
 *
 * Then open that folder in Memry (vault picker).
 *
 * ponytail: media-type inbox items (image/pdf/voice) carry metadata only, no
 * real attachment files; add real media if a demo needs thumbnails.
 */

import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { fileURLToPath } from 'node:url'
import Database from 'better-sqlite3'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import { migrate } from 'drizzle-orm/better-sqlite3/migrator'
import { customAlphabet } from 'nanoid'
import matter from 'gray-matter'
import * as schema from '@memry/db-schema/data-schema'
import { folderConfigs } from '@memry/db-schema/schema/folder-configs'

// ---------------------------------------------------------------------------
// args + paths
// ---------------------------------------------------------------------------

const argv = process.argv.slice(2)
const vaultArg = argv.find((a) => a.startsWith('--vault='))?.slice('--vault='.length)
const force = argv.includes('--force')
const vaultPath = path.resolve(vaultArg ?? path.join(os.homedir(), 'MemryRichVault'))

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const dataMigrations = path.resolve(__dirname, '../src/main/database/drizzle-data')

const memryDir = path.join(vaultPath, '.memry')
const dataDbPath = path.join(memryDir, 'data.db')

// ---------------------------------------------------------------------------
// id + date helpers
// ---------------------------------------------------------------------------

const id12 = customAlphabet('0123456789abcdefghijklmnopqrstuvwxyz', 12)
const noteId = () => id12() // valid 12-char note id (kept in frontmatter)
const id = (prefix: string) => `${prefix}_${id12()}`

const now = new Date()
const tz = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'

const addDays = (n: number): Date => {
  const d = new Date(now)
  d.setDate(d.getDate() + n)
  return d
}
const atTime = (d: Date, h: number, m = 0): Date => {
  const x = new Date(d)
  x.setHours(h, m, 0, 0)
  return x
}
const isoDate = (d: Date): string => {
  // local YYYY-MM-DD (matches journal filenames + date properties)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(
    d.getDate()
  ).padStart(2, '0')}`
}
const ts = (d: Date): string => d.toISOString()
const nowIso = ts(now)

// ---------------------------------------------------------------------------
// vault scaffold
// ---------------------------------------------------------------------------

if (fs.existsSync(memryDir)) {
  if (!force) {
    console.error(
      `Vault already exists at ${vaultPath}\nPass --force to wipe and reseed, or --vault=<other path>.`
    )
    process.exit(1)
  }
  fs.rmSync(vaultPath, { recursive: true, force: true })
}

for (const dir of ['journal', 'attachments', 'attachments/images', 'attachments/files']) {
  fs.mkdirSync(path.join(vaultPath, dir), { recursive: true })
}
fs.mkdirSync(memryDir, { recursive: true })
fs.writeFileSync(
  path.join(memryDir, 'config.json'),
  JSON.stringify(
    {
      excludePatterns: ['.git', 'node_modules', '.trash', '.obsidian', '.memry'],
      defaultNoteFolder: '',
      journalFolder: 'journal',
      journalDateFormat: 'YYYY-MM-DD',
      attachmentsFolder: 'attachments'
    },
    null,
    2
  )
)

// ---------------------------------------------------------------------------
// notes (markdown files w/ frontmatter: emoji icon + tags + properties)
// ---------------------------------------------------------------------------

interface NoteSeed {
  nid: string
  folder: string
  title: string
  emoji: string
  tags: string[]
  props: Record<string, unknown>
  body: string
}

function writeNote(n: NoteSeed): void {
  const created = ts(addDays(-Math.floor(Math.random() * 30) - 1))
  const front: Record<string, unknown> = {
    id: n.nid,
    title: n.title,
    emoji: n.emoji,
    created,
    modified: nowIso,
    tags: n.tags,
    ...n.props // top-level non-reserved keys = properties
  }
  const dir = path.join(vaultPath, n.folder)
  fs.mkdirSync(dir, { recursive: true })
  const file = path.join(dir, `${n.title}.md`)
  fs.writeFileSync(file, matter.stringify(`\n${n.body}\n`, front))
}

// stable ids so tasks/bookmarks can reference notes
const N = {
  roadmap: noteId(),
  meeting: noteId(),
  designSystem: noteId(),
  groceries: noteId(),
  ramen: noteId(),
  hike: noteId(),
  book1: noteId(),
  book2: noteId(),
  budget: noteId(),
  onboarding: noteId()
}

const notes: NoteSeed[] = [
  {
    nid: N.roadmap,
    folder: 'Work/Projects',
    title: 'Q3 Roadmap',
    emoji: '🗺️',
    tags: ['work', 'idea'],
    props: { Status: 'Active', Priority: 'High', Author: 'Jane Rivera' },
    body: `# Q3 Roadmap\n\nNorth star: a calm, private place to think.\n\n## Themes\n- Faster sync\n- Calendar polish — see [[Design System]]\n- Onboarding redo — see [[Onboarding Flow]]\n\n> Ship less, ship calmer. #idea`
  },
  {
    nid: N.meeting,
    folder: 'Work',
    title: 'Weekly Sync Notes',
    emoji: '🗒️',
    tags: ['work', 'meeting'],
    props: { Status: 'In Progress', Priority: 'Medium' },
    body: `# Weekly Sync\n\n- Reviewed [[Q3 Roadmap]]\n- Calendar drag-resize lands Thursday\n- Need copy for empty states\n\n**Action items** captured as tasks. #meeting`
  },
  {
    nid: N.designSystem,
    folder: 'Work/Projects',
    title: 'Design System',
    emoji: '🎨',
    tags: ['work', 'idea'],
    props: { Status: 'Active', Rating: 5, Link: 'https://memrynote.com' },
    body: `# Design System\n\nTerracotta \`#ff671a\` on paper. Restraint over decoration.\n\n## Tokens\n- Type: Zodiak / Satoshi\n- Radius: 12px\n- Motion: 120ms, reduced-motion safe\n\nReferenced by [[Q3 Roadmap]].`
  },
  {
    nid: N.onboarding,
    folder: 'Work/Projects',
    title: 'Onboarding Flow',
    emoji: '🚪',
    tags: ['work'],
    props: { Status: 'Blocked', Priority: 'High', Due: isoDate(addDays(9)) },
    body: `# Onboarding Flow\n\nThree screens, no account wall.\n\n1. Pick a vault\n2. Import (optional)\n3. First note\n\nBlocked on import copy. #urgent`
  },
  {
    nid: N.budget,
    folder: 'Personal',
    title: 'Monthly Budget',
    emoji: '💰',
    tags: ['health'],
    props: { Status: 'Active', Rating: 4 },
    body: `# Monthly Budget\n\nCalm money is calm mind.\n\n- Rent\n- Groceries — see [[Groceries]]\n- Savings 20%`
  },
  {
    nid: N.hike,
    folder: 'Personal',
    title: 'Weekend Hike Plan',
    emoji: '🥾',
    tags: ['health', 'idea'],
    props: { Due: isoDate(addDays(2)) },
    body: `# Weekend Hike\n\nEagle Ridge loop, ~11km.\n\n- [ ] Water + snacks\n- [ ] Check weather\n- [ ] Charge watch\n\n#health`
  },
  {
    nid: N.groceries,
    folder: 'Personal',
    title: 'Groceries',
    emoji: '🛒',
    tags: ['health'],
    props: {},
    body: `# Groceries\n\n- Oats\n- Spinach\n- Eggs\n- Miso (for [[Miso Ramen]])`
  },
  {
    nid: N.ramen,
    folder: 'Recipes',
    title: 'Miso Ramen',
    emoji: '🍜',
    tags: ['recipe'],
    props: { Rating: 5, Author: 'Mom' },
    body: `# Miso Ramen\n\n45 min · serves 2\n\n## Broth\n- Dashi base\n- 2 tbsp white miso\n- Garlic + ginger\n\nPairs with [[Groceries]] run. #recipe`
  },
  {
    nid: N.book1,
    folder: 'Reading',
    title: 'The Pragmatic Programmer — Notes',
    emoji: '📘',
    tags: ['reading', 'idea'],
    props: { Status: 'Done', Rating: 5, Author: 'Hunt & Thomas' },
    body: `# The Pragmatic Programmer\n\n- DRY, but not dogmatically\n- Tracer bullets > big bang\n- Fix broken windows early\n\n#reading`
  },
  {
    nid: N.book2,
    folder: 'Reading',
    title: 'Reading List',
    emoji: '📚',
    tags: ['reading'],
    props: { Status: 'In Progress' },
    body: `# Reading List\n\n- [[The Pragmatic Programmer — Notes]] ✅\n- Thinking in Systems\n- The Creative Act\n\n#reading`
  }
]

notes.forEach(writeNote)

// ---------------------------------------------------------------------------
// journals (journal/<YYYY-MM-DD>.md — date derived from path)
// ---------------------------------------------------------------------------

const journals: Array<{ offset: number; body: string; emoji: string }> = [
  {
    offset: 0,
    emoji: '☀️',
    body: `Slept well. Shipped the calendar resize. Felt good.\n\n- Reviewed [[Q3 Roadmap]]\n- Ran 5k #health`
  },
  { offset: -1, emoji: '🌧️', body: `Rainy. Deep work on [[Design System]] tokens. #idea` },
  {
    offset: -2,
    emoji: '🌤️',
    body: `Pairing day. Untangled sync conflict logic. Coffee count: too high.`
  },
  { offset: -4, emoji: '🌙', body: `Quiet evening. Cooked [[Miso Ramen]]. Read a chapter.` },
  { offset: -7, emoji: '🍃', body: `Week kickoff. Set three intentions. Inbox to zero.` }
]

for (const j of journals) {
  const d = addDays(j.offset)
  const date = isoDate(d)
  fs.writeFileSync(
    path.join(vaultPath, 'journal', `${date}.md`),
    matter.stringify(`\n${j.body}\n`, {
      id: noteId(),
      title: date,
      emoji: j.emoji,
      created: ts(d),
      modified: ts(d),
      tags: []
    })
  )
}

// ---------------------------------------------------------------------------
// data.db
// ---------------------------------------------------------------------------

const raw = new Database(dataDbPath)
raw.pragma('journal_mode = WAL')
raw.pragma('foreign_keys = ON')
raw.pragma('busy_timeout = 5000')
const db = drizzle(raw, { schema })
migrate(db, { migrationsFolder: dataMigrations })

// --- folders (icons) ---
const folders: Array<[string, string]> = [
  ['Work', '💼'],
  ['Work/Projects', '🚀'],
  ['Personal', '🌿'],
  ['Reading', '📚'],
  ['Recipes', '🍳']
]
db.insert(folderConfigs)
  .values(folders.map(([p, icon]) => ({ path: p, icon, createdAt: nowIso, modifiedAt: nowIso })))
  .run()

// --- tags (color + icon) ---
const tags: Array<[string, string, string]> = [
  ['work', '#ff671a', '💼'],
  ['idea', '#f59e0b', '💡'],
  ['urgent', '#ef4444', '🔥'],
  ['reading', '#8b5cf6', '📖'],
  ['health', '#10b981', '🥑'],
  ['meeting', '#3b82f6', '🗓️'],
  ['recipe', '#ec4899', '🍳']
]
db.insert(schema.tagDefinitions)
  .values(tags.map(([name, color, icon]) => ({ name, color, icon, createdAt: nowIso })))
  .run()

// --- property definitions (typed schema; select options use named colors) ---
const propertyDefs = [
  {
    name: 'Status',
    type: 'select',
    options: JSON.stringify([
      { value: 'Active', color: 'blue' },
      { value: 'In Progress', color: 'amber' },
      { value: 'Done', color: 'emerald' },
      { value: 'Blocked', color: 'rose' }
    ]),
    color: null as string | null,
    defaultValue: null as string | null
  },
  {
    name: 'Priority',
    type: 'select',
    options: JSON.stringify([
      { value: 'Low', color: 'stone' },
      { value: 'Medium', color: 'amber' },
      { value: 'High', color: 'rose' }
    ]),
    color: null,
    defaultValue: null
  },
  { name: 'Rating', type: 'number', options: null, color: null, defaultValue: null },
  { name: 'Author', type: 'text', options: null, color: null, defaultValue: null },
  { name: 'Due', type: 'date', options: null, color: null, defaultValue: null },
  { name: 'Link', type: 'url', options: null, color: null, defaultValue: null }
]
db.insert(schema.propertyDefinitions)
  .values(propertyDefs.map((p) => ({ ...p, createdAt: nowIso })))
  .run()

// mirror select-like defs to .memry/properties.md (portable schema export)
const selectLike: Record<string, unknown> = {}
for (const p of propertyDefs) {
  if (p.type === 'select' || p.type === 'multiselect') {
    selectLike[p.name] = { type: p.type, options: JSON.parse(p.options as string) }
  }
}
fs.writeFileSync(
  path.join(memryDir, 'properties.md'),
  matter.stringify('', { properties: selectLike })
)

// --- projects + statuses ---
interface ProjSeed {
  pid: string
  name: string
  color: string
  icon: string | null
  isInbox: boolean
  statuses: Array<{
    sid: string
    name: string
    color: string
    isDefault?: boolean
    isDone?: boolean
  }>
}
const todo = () => id('status')
const P_INBOX = id('proj')
const P_APP = id('proj')
const P_LIFE = id('proj')
const S = {
  appBacklog: todo(),
  appProgress: todo(),
  appDone: todo(),
  lifeTodo: todo(),
  lifeDoing: todo(),
  lifeDone: todo()
}
const projects: ProjSeed[] = [
  { pid: P_INBOX, name: 'Inbox', color: '#6366f1', icon: '📥', isInbox: true, statuses: [] },
  {
    pid: P_APP,
    name: 'Memry App',
    color: '#ff671a',
    icon: '🚀',
    isInbox: false,
    statuses: [
      { sid: S.appBacklog, name: 'Backlog', color: '#6b7280', isDefault: true },
      { sid: S.appProgress, name: 'In Progress', color: '#f59e0b' },
      { sid: S.appDone, name: 'Done', color: '#10b981', isDone: true }
    ]
  },
  {
    pid: P_LIFE,
    name: 'Home & Life',
    color: '#10b981',
    icon: '🌿',
    isInbox: false,
    statuses: [
      { sid: S.lifeTodo, name: 'To Do', color: '#6b7280', isDefault: true },
      { sid: S.lifeDoing, name: 'Doing', color: '#3b82f6' },
      { sid: S.lifeDone, name: 'Done', color: '#10b981', isDone: true }
    ]
  }
]
projects.forEach((p, i) =>
  db
    .insert(schema.projects)
    .values({
      id: p.pid,
      name: p.name,
      color: p.color,
      icon: p.icon,
      position: i,
      isInbox: p.isInbox,
      createdAt: nowIso,
      modifiedAt: nowIso
    })
    .run()
)
const allStatuses = projects.flatMap((p) =>
  p.statuses.map((s, i) => ({
    id: s.sid,
    projectId: p.pid,
    name: s.name,
    color: s.color,
    position: i,
    isDefault: s.isDefault ?? false,
    isDone: s.isDone ?? false,
    createdAt: nowIso
  }))
)
if (allStatuses.length) db.insert(schema.statuses).values(allStatuses).run()

// --- tasks (+ tags + note links) ---
interface TaskSeed {
  tid: string
  project: string
  status: string | null
  title: string
  description?: string
  priority: number
  due?: Date | null
  dueTime?: string
  done?: boolean
  parent?: string | null
  tags?: string[]
  note?: string | null
}
const T = {
  resize: id('task'),
  emptyStates: id('task'),
  emptyCopy: id('task'),
  syncWindow: id('task'),
  onboardCopy: id('task'),
  release: id('task'),
  groceries: id('task'),
  hikePrep: id('task'),
  dentist: id('task'),
  callMom: id('task'),
  budgetReview: id('task'),
  inboxZero: id('task')
}
const tasks: TaskSeed[] = [
  {
    tid: T.resize,
    project: P_APP,
    status: S.appDone,
    title: 'Calendar drag-to-resize',
    priority: 3,
    done: true,
    tags: ['work'],
    note: N.roadmap
  },
  {
    tid: T.emptyStates,
    project: P_APP,
    status: S.appProgress,
    title: 'Polish empty states',
    description: 'Calm copy + illustration for zero-surfaces.',
    priority: 2,
    due: addDays(1),
    tags: ['work', 'idea'],
    note: N.designSystem
  },
  {
    tid: T.emptyCopy,
    project: P_APP,
    status: S.appProgress,
    title: 'Write empty-state copy',
    priority: 1,
    parent: T.emptyStates,
    tags: ['work']
  },
  {
    tid: T.syncWindow,
    project: P_APP,
    status: S.appBacklog,
    title: 'Bounded-concurrency pull window',
    priority: 2,
    due: addDays(5),
    tags: ['work']
  },
  {
    tid: T.onboardCopy,
    project: P_APP,
    status: S.appBacklog,
    title: 'Onboarding import copy',
    description: 'Unblocks [[Onboarding Flow]].',
    priority: 3,
    due: addDays(9),
    tags: ['work', 'urgent'],
    note: N.onboarding
  },
  {
    tid: T.release,
    project: P_APP,
    status: S.appBacklog,
    title: 'Cut 0.4 release',
    priority: 2,
    due: addDays(12),
    dueTime: '16:00',
    tags: ['work']
  },
  {
    tid: T.groceries,
    project: P_LIFE,
    status: S.lifeTodo,
    title: 'Grocery run',
    priority: 1,
    due: addDays(0),
    tags: ['health'],
    note: N.groceries
  },
  {
    tid: T.hikePrep,
    project: P_LIFE,
    status: S.lifeDoing,
    title: 'Prep weekend hike',
    priority: 1,
    due: addDays(2),
    tags: ['health', 'idea'],
    note: N.hike
  },
  {
    tid: T.dentist,
    project: P_LIFE,
    status: S.lifeTodo,
    title: 'Book dentist',
    priority: 2,
    due: addDays(-1),
    tags: ['health']
  },
  {
    tid: T.callMom,
    project: P_LIFE,
    status: S.lifeTodo,
    title: 'Call Mom about ramen recipe',
    priority: 0,
    tags: ['recipe'],
    note: N.ramen
  },
  {
    tid: T.budgetReview,
    project: P_LIFE,
    status: S.lifeDone,
    title: 'Review monthly budget',
    priority: 1,
    done: true,
    tags: ['health'],
    note: N.budget
  },
  { tid: T.inboxZero, project: P_INBOX, status: null, title: 'Process inbox', priority: 0 }
]
tasks.forEach((t, i) =>
  db
    .insert(schema.tasks)
    .values({
      id: t.tid,
      projectId: t.project,
      statusId: t.status,
      parentId: t.parent ?? null,
      title: t.title,
      description: t.description ?? null,
      priority: t.priority,
      position: i,
      dueDate: t.due ? isoDate(t.due) : null,
      dueTime: t.dueTime ?? null,
      sourceNoteId: t.note ?? null,
      completedAt: t.done ? nowIso : null,
      createdAt: nowIso,
      modifiedAt: nowIso
    })
    .run()
)
const taskTagRows = tasks.flatMap((t) => (t.tags ?? []).map((tag) => ({ taskId: t.tid, tag })))
if (taskTagRows.length) db.insert(schema.taskTags).values(taskTagRows).run()
const taskNoteRows = tasks
  .filter((t) => t.note)
  .map((t) => ({ taskId: t.tid, noteId: t.note as string, createdAt: nowIso }))
if (taskNoteRows.length) db.insert(schema.taskNotes).values(taskNoteRows).run()

// --- calendar events ---
const events = [
  {
    title: 'Team standup',
    loc: 'Zoom',
    start: atTime(addDays(0), 9, 30),
    end: atTime(addDays(0), 9, 45),
    allDay: false
  },
  {
    title: 'Design review',
    loc: 'Studio',
    start: atTime(addDays(0), 14, 0),
    end: atTime(addDays(0), 15, 0),
    allDay: false
  },
  {
    title: 'Lunch with Sam',
    loc: 'Café Mori',
    start: atTime(addDays(1), 12, 30),
    end: atTime(addDays(1), 13, 30),
    allDay: false
  },
  {
    title: 'Release window',
    loc: null,
    start: atTime(addDays(12), 16, 0),
    end: atTime(addDays(12), 17, 0),
    allDay: false
  },
  { title: 'Weekend hike', loc: 'Eagle Ridge', start: addDays(2), end: addDays(2), allDay: true },
  {
    title: 'Dentist',
    loc: 'Bright Smile',
    start: atTime(addDays(-1), 8, 0),
    end: atTime(addDays(-1), 8, 45),
    allDay: false
  }
]
db.insert(schema.calendarEvents)
  .values(
    events.map((e) => ({
      id: id('event'),
      title: e.title,
      location: e.loc,
      startAt: e.allDay ? isoDate(e.start) : ts(e.start),
      endAt: e.allDay ? isoDate(e.end) : ts(e.end),
      timezone: tz,
      isAllDay: e.allDay,
      reminders: { useDefault: false, overrides: [{ method: 'popup' as const, minutes: 10 }] },
      visibility: 'default',
      createdAt: nowIso,
      modifiedAt: nowIso
    }))
  )
  .run()

// --- inbox items (+ tags) ---
interface InboxSeed {
  type: string
  title: string
  content?: string | null
  url?: string | null
  sourceTitle?: string | null
  capture: string
  transcription?: string | null
  tags?: string[]
}
const inbox: InboxSeed[] = [
  {
    type: 'link',
    title: 'Local-first software (Ink & Switch)',
    url: 'https://www.inkandswitch.com/local-first/',
    capture: 'browser-extension',
    tags: ['idea', 'reading']
  },
  {
    type: 'clip',
    title: 'The calm technology checklist',
    url: 'https://calmtech.com',
    sourceTitle: 'Calm Tech',
    content: 'Tech should require the smallest possible amount of attention…',
    capture: 'browser-extension',
    tags: ['idea']
  },
  {
    type: 'note',
    title: 'Idea: weekly review template',
    content: 'Three sections — wins, drags, next. Keep it under five minutes.',
    capture: 'quick-capture',
    tags: ['idea']
  },
  {
    type: 'social',
    title: 'Thread on SQLite as an app file format',
    url: 'https://x.com/example/status/123',
    capture: 'browser-extension',
    tags: ['reading']
  },
  {
    type: 'voice',
    title: 'Voice memo — onboarding thoughts',
    transcription: 'What if step one is just… pick a folder. No account. No friction.',
    capture: 'quick-capture'
  },
  {
    type: 'reminder',
    title: 'Follow up on release notes',
    content: 'Triggered reminder waiting in inbox.',
    capture: 'reminder'
  }
]
for (const it of inbox) {
  const itemId = id(`inbox_${it.type.slice(0, 3)}`)
  db.insert(schema.inboxItems)
    .values({
      id: itemId,
      type: it.type,
      title: it.title,
      content: it.content ?? null,
      sourceUrl: it.url ?? null,
      sourceTitle: it.sourceTitle ?? null,
      transcription: it.transcription ?? null,
      transcriptionStatus: it.transcription ? 'complete' : null,
      processingStatus: 'complete',
      captureSource: it.capture,
      createdAt: nowIso,
      modifiedAt: nowIso
    })
    .run()
  if (it.tags?.length) {
    db.insert(schema.inboxItemTags)
      .values(it.tags.map((tag) => ({ id: id('itag'), itemId, tag, createdAt: nowIso })))
      .run()
  }
}

// --- bookmarks (tasks are stable; notes best-effort post-index) ---
db.insert(schema.bookmarks)
  .values([
    { id: id('bm'), itemType: 'task', itemId: T.onboardCopy, position: 0, createdAt: nowIso },
    { id: id('bm'), itemType: 'task', itemId: T.emptyStates, position: 1, createdAt: nowIso },
    { id: id('bm'), itemType: 'note', itemId: N.roadmap, position: 2, createdAt: nowIso },
    { id: id('bm'), itemType: 'note', itemId: N.designSystem, position: 3, createdAt: nowIso }
  ])
  .run()

// --- home board: one widget of every supported type ---
const widget = (type: string, x: number, y: number, config: Record<string, unknown> = {}) => ({
  id: id12(),
  type,
  x,
  y,
  w: 4,
  h: 4,
  config
})
db.insert(schema.homePages)
  .values({
    id: id('home'),
    name: 'Dashboard',
    icon: '🏠',
    position: 0,
    widgets: JSON.stringify([
      widget('recently-edited', 0, 0),
      widget('tasks', 4, 0, { dateRange: 'today' }),
      widget('calendar', 8, 0),
      widget('journal', 0, 4),
      widget('folder', 4, 4, { folderPath: 'Work' }),
      widget('inbox', 8, 4),
      widget('bookmarks', 0, 8, { itemType: 'task' })
    ]),
    createdAt: nowIso,
    updatedAt: nowIso
  })
  .run()

raw.close()

const counts = {
  notes: notes.length,
  journals: journals.length,
  folders: folders.length,
  tags: tags.length,
  properties: propertyDefs.length,
  projects: projects.length,
  tasks: tasks.length,
  events: events.length,
  inbox: inbox.length,
  widgets: 7
}
console.log(`✓ Seeded rich vault at ${vaultPath}`)
console.log(`  ${JSON.stringify(counts)}`)
console.log(`\nOpen it in Memry: vault picker → ${vaultPath}`)
console.log('(First open indexes notes — search + tags + properties populate automatically.)')
