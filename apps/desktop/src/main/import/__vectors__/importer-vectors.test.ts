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
import type { Importer, ImportInput, ImportSummary } from '../types'
import { createImportContext } from '../import-context'
import { bearImporter } from '../bear/bear-importer'
import { markdownImporter } from '../markdown/markdown-importer'
import { csvImporter } from '../csv/csv-importer'
import { googleKeepImporter } from '../google-keep/google-keep-importer'

const rec = vi.hoisted(() => ({ timeline: [] as unknown[], noteCounter: 0 }))

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

interface VectorCase {
  name: string
  /** Picked paths, relative to the source's `input/` folder. */
  sources: string[]
  preview?: boolean
}

const SOURCES: { source: string; importer: Importer; cases: VectorCase[] }[] = [
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

async function runCase(source: string, importer: Importer, c: VectorCase): Promise<unknown> {
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
    const controller = new AbortController()
    const input: ImportInput = { sourcePaths: c.sources.map((s) => path.join(work, s)) }
    const preview = c.preview ? await importer.preview?.(input, controller.signal) : undefined
    const ctx = createImportContext('vector', controller.signal)
    await importer.run(input, ctx)
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

  for (const { source, importer, cases } of SOURCES) {
    it(`${source}/expected.json matches the TypeScript importer`, async () => {
      const recorded: unknown[] = []
      for (const c of cases) recorded.push(await runCase(source, importer, c))
      const file = path.join(VECTORS, source, 'expected.json')
      const text = vectorText(file, { source, cases: recorded })
      expect(fs.readFileSync(file, 'utf8'), STALE).toBe(text)
    })
  }
})
