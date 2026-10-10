import Database from 'better-sqlite3'

import { createMemryApp } from '../app-core/memry-app.ts'
import { getDataDbPath, getIndexDbPath } from '../app-core/paths.ts'
import { createClock } from './clock.ts'
import { createContext, type SandboxStep } from './context.ts'
import { runPostSteps } from './post/index.ts'
import { createInbox } from './steps/inbox.ts'
import { createShells, writeBodies, writeJournal, writeVersions } from './steps/notes.ts'
import { organize } from './steps/organize.ts'
import { setup } from './steps/setup.ts'
import { defineTags } from './steps/tags.ts'
import { writeCanvases } from './steps/canvases.ts'
import { createEvents, createTasks } from './steps/work.ts'

// Order matters: shells first so everything can point at a note id, bodies
// after tasks, events and canvases exist, inbox filing after the bodies it
// appends to.
const steps: SandboxStep[] = [
  setup,
  defineTags,
  createShells,
  createEvents,
  createTasks,
  writeCanvases,
  writeBodies,
  writeJournal,
  writeVersions,
  createInbox,
  organize
]

export type SandboxCounts = Record<string, number>

const COUNTS: Array<[string, 'data' | 'index', string]> = [
  [
    'notes',
    'data',
    "SELECT count(*) FROM note_metadata WHERE file_type = 'markdown' AND journal_date IS NULL"
  ],
  ['journal entries', 'data', 'SELECT count(*) FROM note_metadata WHERE journal_date IS NOT NULL'],
  ['files', 'data', "SELECT count(*) FROM note_metadata WHERE file_type != 'markdown'"],
  ['projects', 'data', 'SELECT count(*) FROM projects'],
  ['tasks', 'data', 'SELECT count(*) FROM tasks'],
  ['inbox items', 'data', 'SELECT count(*) FROM inbox_items'],
  ['calendar events', 'data', 'SELECT count(*) FROM calendar_events'],
  ['reminders', 'data', 'SELECT count(*) FROM reminders'],
  ['bookmarks', 'data', 'SELECT count(*) FROM bookmarks'],
  ['templates', 'data', 'SELECT count(*) FROM templates'],
  ['saved filters', 'data', 'SELECT count(*) FROM saved_filters'],
  ['tags', 'data', 'SELECT count(*) FROM tag_definitions'],
  ['tags with fields', 'data', 'SELECT count(*) FROM tag_definitions WHERE schema IS NOT NULL'],
  ['tasks with fields', 'data', 'SELECT count(*) FROM tasks WHERE fields IS NOT NULL'],
  ['task activity', 'data', 'SELECT count(*) FROM task_activity'],
  ['versions', 'index', 'SELECT count(*) FROM note_snapshots']
]

function countEntities(vaultPath: string): SandboxCounts {
  const data = new Database(getDataDbPath(vaultPath), { readonly: true })
  const index = new Database(getIndexDbPath(vaultPath), { readonly: true })
  try {
    return Object.fromEntries(
      COUNTS.map(([name, db, sql]) => [
        name,
        (db === 'data' ? data : index).prepare(sql).pluck().get() as number
      ])
    )
  } finally {
    data.close()
    index.close()
  }
}

/** Builds the sandbox vault into `vaultPath`, which must be an empty directory. */
export async function generateSandbox(vaultPath: string, now: Date): Promise<SandboxCounts> {
  const app = await createMemryApp({ vaultPath })
  const ctx = createContext(app, vaultPath, createClock(now))
  try {
    for (const step of steps) await step(ctx)
  } finally {
    app.close()
  }
  await runPostSteps(ctx)
  return { ...countEntities(vaultPath), canvases: ctx.canvasIds.size }
}
