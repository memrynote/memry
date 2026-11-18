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
import type { AttachmentResult } from '../../vault/attachments'
import type * as IdModule from '../../lib/id'
import type * as AttachmentsModule from '../../vault/attachments'
import type * as FsPromises from 'fs/promises'
import type { Importer, ImportInput } from '../types'
import { createImportContext } from '../import-context'
import { attachmentMarkdown } from '../_shared/attachment-markdown'
import { markdownImporter } from '../markdown/markdown-importer'
import { csvImporter } from '../csv/csv-importer'
import { htmlImporter } from '../html/html-importer'
import { evernoteImporter } from '../evernote/evernote-importer'
import { appleJournalImporter } from '../apple-journal/apple-journal-importer'

const rec = vi.hoisted(() => ({
  timeline: [] as unknown[],
  noteCounter: 0,
  /** Each saved file's result by the MD5 of its bytes, which is an Evernote resource's hash. */
  savedByMd5: new Map<string, AttachmentResult>()
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
      const result = {
        success: true,
        path: `attachments/${noteId}/${name}`,
        name,
        size: data.length,
        mimeType: actual.getMimeType(name),
        type: actual.getFileType(name)
      }
      rec.savedByMd5.set(createHash('md5').update(data).digest('hex'), result)
      return result
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

interface VectorCase {
  name: string
  /** Picked paths, relative to the source's `input/` folder. */
  sources: string[]
  preview?: boolean
  /** Record `created` as written: it comes from the source, not from the file's birth time. */
  exactCreated?: boolean
}

/**
 * An Electron bug the Rust importer fixes, listed in #3549's Departures: it rewrites the body
 * the TypeScript importer wrote, so the vector holds the fixed output.
 */
type Departure = (content: string) => string

/**
 * Evernote: a non-image attachment's placeholder `[[attachment]](memry-enex:H)` has brackets in
 * its label, so neither the rewrite nor the strip regex matched it and the note kept the internal
 * link. Fixed, it becomes the saved file's block, or nothing.
 */
const enexAttachmentLink: Departure = (content) =>
  content.replace(/\[\[attachment\]\]\(memry-enex:([^)]*)\)/g, (_match, hash: string) => {
    const saved = rec.savedByMd5.get(hash)
    return (saved && attachmentMarkdown(saved)) ?? ''
  })

const SOURCES: {
  source: string
  importer: Importer
  cases: VectorCase[]
  departures?: Departure[]
}[] = [
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
    source: 'html',
    importer: htmlImporter,
    cases: [
      { name: 'sample', sources: ['site/page-one.html', 'site/page-two.htm', 'site/notes.txt'] },
      { name: 'empty-body', sources: ['site/empty.html'] }
    ]
  },
  {
    source: 'evernote',
    importer: evernoteImporter,
    departures: [enexAttachmentLink],
    cases: [
      {
        name: 'sample',
        sources: ['My   Notebook .enex', '.enex', 'empty.enex', 'bad-date.enex'],
        exactCreated: true
      }
    ]
  },
  {
    source: 'apple-journal',
    importer: appleJournalImporter,
    cases: [
      {
        name: 'sample',
        sources: ['entry-1.html', 'index.html', 'entry-2.html', 'no-date.html'],
        exactCreated: true
      }
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

function noteRecord(
  input: NoteCreateInput,
  exactCreated: boolean,
  departures: Departure[]
): unknown {
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
    created: input.created ? (exactCreated ? input.created : '<birthtime>') : null,
    modified: input.modified ?? null,
    content: departures.reduce((content, fix) => fix(content), input.content ?? '')
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
  departures: Departure[]
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
    rec.savedByMd5.clear()
    const controller = new AbortController()
    const input: ImportInput = { sourcePaths: c.sources.map((s) => path.join(work, s)) }
    const preview = c.preview ? await importer.preview?.(input, controller.signal) : undefined
    const ctx = createImportContext('vector', controller.signal)
    await importer.run(input, ctx)
    const summary = ctx.toSummary()
    return {
      ...c,
      ...(preview ? { preview } : {}),
      timeline: rec.timeline.map((entry) => {
        const e = entry as { op: string; input?: NoteCreateInput }
        return e.op === 'createNote' && e.input
          ? noteRecord(e.input, c.exactCreated ?? false, departures)
          : entry
      }),
      summary: {
        ...summary,
        failed: summary.failed.map(({ item, error }) => ({ item: unroot(item), error }))
      }
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

  for (const { source, importer, cases, departures = [] } of SOURCES) {
    it(`${source}/expected.json matches the TypeScript importer`, async () => {
      const recorded: unknown[] = []
      for (const c of cases) recorded.push(await runCase(source, importer, c, departures))
      const file = path.join(VECTORS, source, 'expected.json')
      const text = vectorText(file, { source, cases: recorded })
      expect(fs.readFileSync(file, 'utf8'), STALE).toBe(text)
    })
  }
})
