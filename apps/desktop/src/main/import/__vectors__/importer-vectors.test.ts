/**
 * Importer vectors (Step 32, #3549): runs the TypeScript importers over the inputs in
 * `packages/contracts/test-vectors/importers/<source>/input/` and records every write they
 * make. The Rust importers replay the same inputs in
 * `crates/memry-desktop/tests/importer_vectors.rs` and must record the same thing.
 *
 * The writes go to a recording sink instead of the vault: `createImportedNote`,
 * `saveAttachment` and `generateNoteId` are mocked, note ids come from a counter, and every
 * progress snapshot the real import context broadcasts is recorded in the same timeline.
 * `readdir` lists a folder by name, because Node returns the file system's order and the
 * Rust importer sorts.
 *
 * `MEMRY_WRITE_VECTORS=1` rewrites the committed files; without it the test fails when they
 * differ. The vectors freeze when the TypeScript importers are deleted: fix the Rust, not the
 * vector.
 */

import { createHash } from 'crypto'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { describe, expect, it, vi } from 'vitest'
import { MAX_SKIPPED_REASON_GROUPS } from '@memry/contracts/import-channels'
import {
  IMPORT_MESSAGE_CODES,
  IMPORT_STATUS,
  IMPORT_STATUS_CODES,
  importingItemStatus,
  onenoteDownloadingAttachmentStatus
} from '@memry/importers/messages'
import type { NoteCreateInput } from '../../vault/notes-crud'
import type * as IdModule from '../../lib/id'
import type * as AttachmentsModule from '../../vault/attachments'
import type * as FsPromises from 'fs/promises'
import type * as NotesCrudModule from '../../vault/notes-crud'
import type * as JournalModule from '../../vault/journal'
import type { Importer, ImportContext, ImportInput, ImportSummary } from '../types'
import { createImportContext } from '../import-context'
import { bearImporter } from '../bear/bear-importer'
import { markdownImporter } from '../markdown/markdown-importer'
import { csvImporter } from '../csv/csv-importer'
import { googleKeepImporter } from '../google-keep/google-keep-importer'
import { roamImporter } from '../roam/roam-importer'
import { notePlanImporter, runNotePlanImport } from '../noteplan/noteplan-importer'
import type { NotePlanTaskDeps } from '../noteplan/noteplan-importer'
import { raindropImporter, runRaindropImport } from '../raindrop/raindrop-importer'
import type { ApplyDeps as RaindropDeps } from '../raindrop/raindrop-importer'
import {
  applyTodoistImport,
  buildTodoistPreview,
  todoistImporter
} from '../todoist/todoist-importer'
import type { ImportTasksDomain } from '../todoist/todoist-importer'

interface StoredJournal {
  content: string
  tags: string[]
  properties: Record<string, unknown>
}

const rec = vi.hoisted(() => ({
  timeline: [] as unknown[],
  noteCounter: 0,
  taskCounter: 0,
  projectCounter: 0,
  journals: {} as Record<string, StoredJournal>
}))

vi.mock('../../lib/window-broadcast', () => ({
  broadcastToAllWindows: (_channel: string, payload: unknown) => {
    rec.timeline.push({ op: 'progress', ...JSON.parse(JSON.stringify(payload)) })
  }
}))

vi.mock('../../lib/id', async (importOriginal) => ({
  ...(await importOriginal<typeof IdModule>()),
  generateNoteId: () => `note-${++rec.noteCounter}`
}))

vi.mock('../_shared/imported-note', () => ({
  createImportedNote: async (input: NoteCreateInput) => {
    rec.timeline.push({ op: 'createNote', input })
    return {}
  }
}))

// NotePlan creates its notes without `createImportedNote`'s checklist step.
vi.mock('../../vault/notes-crud', async (importOriginal) => ({
  ...(await importOriginal<typeof NotesCrudModule>()),
  createNote: async (input: NoteCreateInput) => {
    rec.timeline.push({ op: 'createNoteAsWritten', input })
    return {}
  }
}))

vi.mock('../../journal/create-entry', () => ({
  resolveJournalEntryId: (date: string) => `j${date}`,
  createJournalEntry: async (input: {
    date: string
    content: string
    tags?: string[]
    properties?: Record<string, unknown>
  }) => {
    rec.timeline.push({
      op: 'createJournalEntry',
      date: input.date,
      tags: input.tags ?? [],
      properties: input.properties
        ? Object.entries(input.properties).map(([key, value]) => [key, tagValue(value)])
        : null,
      content: input.content
    })
    return {}
  }
}))

vi.mock('../../vault/journal', async (importOriginal) => ({
  ...(await importOriginal<typeof JournalModule>()),
  readJournalEntry: async (date: string) => rec.journals[date] ?? null
}))

vi.mock('../../vault/attachments', async (importOriginal) => {
  const actual = await importOriginal<typeof AttachmentsModule>()
  return {
    ...actual,
    saveAttachment: async (noteId: string, data: Buffer, name: string) => {
      if (!actual.isAllowedFileType(name)) {
        rec.timeline.push({ op: 'saveAttachment', noteId, name, refused: true })
        return {
          success: false,
          error: `unsupported attachment type .${actual.getFileExtension(name)}`
        }
      }
      const sha256 = createHash('sha256').update(data).digest('hex')
      rec.timeline.push({ op: 'saveAttachment', noteId, name, size: data.length, sha256 })
      return {
        success: true,
        path: `attachments/${noteId}/${name}`,
        name,
        size: data.length,
        mimeType: actual.getMimeType(name),
        type: actual.getFileType(name)
      }
    }
  }
})

vi.mock('fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof FsPromises>()
  const readdir = async (...args: Parameters<typeof actual.readdir>) => {
    const entries = (await actual.readdir(...args)) as unknown as (string | { name: string })[]
    const name = (entry: string | { name: string }) =>
      typeof entry === 'string' ? entry : entry.name
    return entries.toSorted((a, b) => (name(a) < name(b) ? -1 : name(a) > name(b) ? 1 : 0))
  }
  return { ...actual, readdir, default: { ...actual, readdir } }
})

const VECTORS = path.resolve(
  __dirname,
  '../../../../../../packages/contracts/test-vectors/importers'
)
/** Every input file's modification time, so `modified` is the same on every machine. */
const FIXED_TIME = new Date('2026-01-14T12:00:00.000Z')
/** Todoist's clock for relative dates: noon of 2026-01-14 in the machine's own time zone. */
const TODOIST_NOW = new Date(2026, 0, 14, 12)

interface VectorCase {
  name: string
  /** Picked paths, relative to the source's `input/` folder. */
  sources: string[]
  preview?: boolean
  /** NotePlan: the Inbox project's id, `null` for none. Default `inbox`. */
  inboxProjectId?: string | null
  /** NotePlan: the `tasks.nestedSubtasks` setting. Default true. */
  nestedSubtasks?: boolean
  /** NotePlan: the journal entries `readJournalEntry` finds, by date. */
  journals?: Record<string, StoredJournal>
}

/** NotePlan's task side, recorded: ids come from a counter. */
const recordingTaskDeps = (c: VectorCase): NotePlanTaskDeps => ({
  async createTask(a) {
    rec.timeline.push({ op: 'createTask', ...a })
    return { success: true, task: { id: `task-${++rec.taskCounter}` } }
  },
  async completeTask(a) {
    rec.timeline.push({
      op: 'completeTask',
      id: a.id,
      completedAt: a.completedAt ?? null,
      recordOnly: a.recordOnly ?? false
    })
    return {}
  },
  async archiveTask(id) {
    rec.timeline.push({ op: 'archiveTask', id })
    return {}
  },
  getInboxProjectId: () =>
    c.inboxProjectId === undefined ? 'inbox' : (c.inboxProjectId ?? undefined),
  nestedSubtasks: () => c.nestedSubtasks ?? true
})

/** Raindrop's `saveBookmark`, recorded. */
const recordingBookmarks: RaindropDeps = {
  saveBookmark(item) {
    rec.timeline.push({ op: 'saveBookmark', ...item })
  }
}

/** Todoist's tasks domain, recorded: ids come from counters. */
const recordingProjects: ImportTasksDomain = {
  async createProject(input) {
    rec.timeline.push({ op: 'createProject', ...input })
    return { project: { id: `project-${++rec.projectCounter}` } }
  },
  async createTask(input) {
    rec.timeline.push({ op: 'createTask', ...input })
    return { task: { id: `task-${++rec.taskCounter}` } }
  }
}

type Preview = NonNullable<Importer['preview']>

const SOURCES: {
  source: string
  importer: Importer
  /** Runs one case; the importer's own `run` when absent. */
  run?: (input: ImportInput, ctx: ImportContext, c: VectorCase) => Promise<unknown>
  /** Previews one case; the importer's own `preview` when absent. */
  preview?: Preview
  cases: VectorCase[]
}[] = [
  {
    source: 'bear',
    importer: bearImporter,
    cases: [
      { name: 'backup', sources: ['export.bear2bk'] },
      { name: 'two-zips', sources: ['export.bear2bk', 'more.zip'] }
    ]
  },
  {
    source: 'markdown',
    importer: markdownImporter,
    cases: [
      { name: 'sample', sources: ['sample'] },
      { name: 'wiki-embeds', sources: ['wiki-embeds'] },
      { name: 'nested-assets', sources: ['nested-assets'] },
      { name: 'single-file', sources: ['sample/root-note.md'] },
      { name: 'edge', sources: ['edge'] },
      { name: 'mixed-picks', sources: ['edge/crlf.md', 'edge/ignored.txt', 'wiki-embeds'] }
    ]
  },
  {
    source: 'csv',
    importer: csvImporter,
    cases: [
      { name: 'sample', sources: ['sample.csv'], preview: true },
      {
        name: 'many',
        sources: ['edge.csv', 'crlf.csv', 'empty.csv', 'keys.csv'],
        preview: true
      }
    ]
  },
  {
    source: 'google-keep',
    importer: googleKeepImporter,
    cases: [
      { name: 'takeout', sources: ['Takeout.zip'] },
      {
        name: 'loose',
        sources: ['loose/Loose note.json', 'loose/bad.json', 'loose/readme.txt', 'loose/array.json']
      },
      { name: 'mixed', sources: ['loose/Loose note.json', 'Takeout.zip'] }
    ]
  },
  {
    source: 'noteplan',
    importer: notePlanImporter,
    run: (input, ctx, c) => runNotePlanImport(input, ctx, recordingTaskDeps(c)),
    cases: [
      { name: 'sample', sources: ['sample'] },
      {
        name: 'edge',
        sources: ['edge'],
        journals: {
          '2026-01-01': {
            content: '  My own words\n',
            tags: ['mine', 'daily'],
            properties: { weather: 'sun', mood: 'calm' }
          }
        }
      },
      { name: 'flat-subtasks', sources: ['bare'], nestedSubtasks: false },
      { name: 'no-inbox', sources: ['bare', 'sample/Notes'], inboxProjectId: null }
    ]
  },
  {
    source: 'raindrop',
    importer: raindropImporter,
    // `raindropImporter.run` with the recording deps, and `<now>` as the run's clock: the Rust
    // sink fills in the import time where the plan falls back to it.
    run: async (input, ctx) => {
      ctx.setPhase('importing')
      ctx.status(IMPORT_STATUS.raindropImporting)
      await runRaindropImport(input.sourcePaths, recordingBookmarks, ctx, '<now>')
    },
    cases: [
      { name: 'export', sources: ['export.csv'] },
      { name: 'many', sources: ['edge.csv', 'bad-header.csv', 'empty.csv', 'clean.csv'] },
      { name: 'preview', sources: ['clean.csv', 'bad-header.csv', 'empty.csv'], preview: true }
    ]
  },
  {
    source: 'todoist',
    importer: todoistImporter,
    // `todoistImporter.run` and its preview with the recording domain and a fixed clock.
    run: async (input, ctx) => {
      ctx.setPhase('importing')
      ctx.status(IMPORT_STATUS.todoistImporting)
      await applyTodoistImport(input.sourcePaths, recordingProjects, ctx, TODOIST_NOW)
    },
    preview: (input, signal) => buildTodoistPreview(input.sourcePaths, TODOIST_NOW, signal),
    cases: [
      { name: 'export', sources: ['Personal.csv'], preview: true },
      {
        name: 'many',
        sources: ['edge.csv', 'not-todoist.csv', 'empty.csv', 'Shout.CSV'],
        preview: true
      }
    ]
  },
  {
    source: 'roam',
    importer: roamImporter,
    cases: [
      { name: 'graph', sources: ['graph.json'] },
      { name: 'two-files', sources: ['not-pages.json', 'graph.json', 'edge.json'] }
    ]
  }
]

/** A frontmatter value as JSON, with the types JSON lacks tagged. */
function tagValue(value: unknown): unknown {
  if (value instanceof Date) return { $date: value.toISOString() }
  if (value instanceof Uint8Array) return { $binary: Buffer.from(value).toString('base64') }
  if (Array.isArray(value)) return value.map(tagValue)
  if (typeof value === 'number' && !Number.isFinite(value)) return { $number: String(value) }
  if (value !== null && typeof value === 'object') {
    return { $map: Object.entries(value).map(([key, inner]) => [key, tagValue(inner)]) }
  }
  return value
}

function noteRecord(input: NoteCreateInput): unknown {
  return {
    op: 'createNote',
    id: input.id ?? null,
    title: input.title,
    folder: input.folder ?? null,
    tags: input.tags ?? [],
    properties: Object.entries(input.properties ?? {}).map(([key, value]) => [
      key,
      tagValue(value)
    ]),
    // The birth time cannot be set on a copied file; only its presence is compared.
    created: input.created ? '<birthtime>' : null,
    modified: input.modified ?? null,
    content: input.content ?? ''
  }
}

function setTimes(dir: string): void {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) setTimes(full)
    else fs.utimesSync(full, FIXED_TIME, FIXED_TIME)
  }
}

async function runCase(
  source: string,
  importer: Importer,
  c: VectorCase,
  run?: (input: ImportInput, ctx: ImportContext, c: VectorCase) => Promise<unknown>,
  previewCase: Preview | undefined = importer.preview
): Promise<unknown> {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'memry-import-vectors-'))
  try {
    fs.cpSync(path.join(VECTORS, source, 'input'), work, { recursive: true })
    setTimes(work)
    const unroot = (text: string): string =>
      text
        .split(fs.realpathSync(work))
        .join('<input>')
        .split(work)
        .join('<input>')
        .replace(/\\/g, '/')

    rec.timeline = []
    rec.noteCounter = 0
    rec.taskCounter = 0
    rec.projectCounter = 0
    rec.journals = c.journals ?? {}
    const controller = new AbortController()
    const input: ImportInput = { sourcePaths: c.sources.map((s) => path.join(work, s)) }
    const preview = c.preview ? await previewCase?.(input, controller.signal) : undefined
    const ctx = createImportContext('vector', controller.signal)
    await (run ? run(input, ctx, c) : importer.run(input, ctx))
    // A failed item names the picked file; a `done` snapshot an importer emits carries it too.
    const unrootSummary = (summary: ImportSummary): ImportSummary => ({
      ...summary,
      failed: summary.failed.map(({ item, error }) => ({ item: unroot(item), error }))
    })
    return {
      ...c,
      ...(preview ? { preview } : {}),
      timeline: rec.timeline.map((entry) => {
        const e = entry as { op: string; input?: NoteCreateInput; summary?: ImportSummary }
        if (e.op === 'createNote' && e.input) return noteRecord(e.input)
        if (e.op === 'createNoteAsWritten' && e.input) {
          return { ...(noteRecord(e.input) as object), op: 'createNoteAsWritten' }
        }
        return e.summary ? { ...e, summary: unrootSummary(e.summary) } : entry
      }),
      summary: unrootSummary(ctx.toSummary())
    }
  } finally {
    fs.rmSync(work, { recursive: true, force: true })
  }
}

/** The file's expected text; written first under `MEMRY_WRITE_VECTORS=1`. */
function vectorText(file: string, value: unknown): string {
  const text = `${JSON.stringify(value, null, 2)}\n`
  if (process.env.MEMRY_WRITE_VECTORS === '1') fs.writeFileSync(file, text)
  return text
}

const STALE = 'stale vector file: run with MEMRY_WRITE_VECTORS=1'

describe('importer vectors', () => {
  it('messages.json holds the message codes and status lines', () => {
    const file = path.join(VECTORS, 'messages.json')
    const text = vectorText(file, {
      codes: IMPORT_MESSAGE_CODES,
      statusCodes: IMPORT_STATUS_CODES,
      status: Object.entries(IMPORT_STATUS).map(([key, line]) => [key, line.code, line.message]),
      importingItem: importingItemStatus('T'),
      onenoteDownloadingAttachment: onenoteDownloadingAttachmentStatus('N'),
      maxSkippedReasonGroups: MAX_SKIPPED_REASON_GROUPS
    })
    expect(fs.readFileSync(file, 'utf8'), STALE).toBe(text)
  })

  for (const { source, importer, run, preview, cases } of SOURCES) {
    it(`${source}/expected.json matches the TypeScript importer`, async () => {
      const recorded: unknown[] = []
      for (const c of cases)
        recorded.push(await runCase(source, importer, c, run, preview ?? importer.preview))
      const file = path.join(VECTORS, source, 'expected.json')
      const text = vectorText(file, { source, cases: recorded })
      expect(fs.readFileSync(file, 'utf8'), STALE).toBe(text)
    })
  }
})
