/**
 * Generates the Readwise vault-format vectors in `packages/contracts/test-vectors/readwise/` by
 * running the TypeScript planners (`packages/importers/src/readwise/`), the image naming and the
 * reader full-text converter in place. The Rust port (`crates/memry-desktop/src/readwise/`)
 * reproduces every output byte for byte in `crates/memry-desktop/tests/readwise_vectors.rs`.
 *
 *   MEMRY_WRITE_VECTORS=1 pnpm --filter @memry/desktop exec vitest run --config config/vitest.config.ts src/main/readwise/__vectors__
 *
 * writes the files; without the variable the test regenerates them in memory and fails on drift.
 * A failing Rust vector means the Rust is wrong: fix the Rust, never the vector.
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import * as Y from 'yjs'
import { CRDT_FRAGMENT_NAME } from '@memry/contracts/ipc-crdt'
import { writeMarkdownSourceToYDoc } from '@memry/shared/markdown-source'
import {
  hashSectionBody,
  highlightDay,
  highlightInstant,
  imageHighlightUrl,
  linkedHighlightIds,
  planAppend,
  planJournalAppend,
  planJournalDay,
  planJournalWrite,
  planNote,
  planReaderNote,
  readDaySection,
  readSection,
  sealSection,
  writeEndMarker,
  type ReaderDocument
} from '@memry/importers/readwise'
import { COVER_PATH, COVER_URL, FULL_BOOK, TRICKY_BOOK } from '@memry/importers/readwise/fixtures'
import { imageFileStem } from '../images'
import { prepareReaderFullText } from '../reader-full-text'
import {
  APPEND_CASES,
  BIG_HASH,
  BODIES,
  BOOK_CASES,
  DAY_BODIES,
  HASH_INPUTS,
  JOURNAL_CASES,
  HIGHLIGHT_DATES,
  LINKED_MARKDOWN,
  IMAGE_TEXTS,
  JOURNAL_TITLES
} from './cases'
import { IMAGE_URLS, READER_CASES, READER_FULL_TEXT_CASES } from './reader-cases'

const DIR = resolve(__dirname, '../../../../../../packages/contracts/test-vectors/readwise')

function attempt<T>(run: () => T): T | { error: string } {
  try {
    return run()
  } catch (error) {
    return { error: error instanceof Error ? error.name : String(error) }
  }
}

const pairs = (images: Array<[string, string]> | undefined): Map<string, string> =>
  new Map(images ?? [])

async function editorRoundTrip(markdown: string): Promise<string> {
  const converter = await import('../../sync/blocknote-converter')
  const doc = new Y.Doc()
  expect(
    await converter.markdownToYFragment(markdown, doc.getXmlFragment(CRDT_FRAGMENT_NAME))
  ).toBe(true)
  writeMarkdownSourceToYDoc(doc, null)
  return (await converter.yDocToMarkdown(doc)) as string
}

async function sectionVectors(): Promise<unknown> {
  const plan = planNote(FULL_BOOK, {
    root: 'Readwise',
    folderLayout: 'by-category',
    categories: {},
    timeZone: 'UTC',
    images: new Map([[COVER_URL, COVER_PATH]])
  }) as { section: string }
  const sealed = plan.section
  const roundTripped = await editorRoundTrip(`Intro.\n\n${sealed}\n\nOutro.`)
  const bodies = [
    ...BODIES,
    { name: 'editor round trip of a TypeScript-written note', body: roundTripped },
    {
      name: 'editor round trip, then an edit outside the section',
      body: roundTripped.replace('Intro.', 'Intro, edited.')
    }
  ]
  return {
    hash: HASH_INPUTS.map((input) => ({ input, hash: hashSectionBody(input) })),
    bigHash: { ...BIG_HASH, hash: hashSectionBody(BIG_HASH.unit.repeat(BIG_HASH.times)) },
    seal: BODIES.slice(0, 6).map(({ body }, i) => ({
      body,
      last: i % 2 === 0 ? '2026-10-22T18:05:00.001Z' : '1970-01-01T00:00:00.000Z',
      out: sealSection(body, i % 2 === 0 ? '2026-10-22T18:05:00.001Z' : '1970-01-01T00:00:00.000Z')
    })),
    endMarker: [
      { last: '2026-10-22T18:05:00.001Z', hash: '0badf00d' },
      { last: 'x', hash: '00000000' }
    ].map((marker) => ({ ...marker, out: writeEndMarker(marker) })),
    read: bodies.map(({ name, body }) => ({ name, body, out: readSection(body) })),
    readDay: DAY_BODIES.map(({ name, body }) => ({ name, body, out: readDaySection(body) }))
  }
}

function planNoteVectors(): unknown {
  return BOOK_CASES.map(({ name, book: source, options }) => ({
    name,
    book: source,
    options,
    out: attempt(() => planNote(source, { ...options, images: pairs(options.images) }))
  }))
}

function planAppendVectors(): unknown {
  return {
    cases: APPEND_CASES.map(({ name, highlights, options }) => ({
      name,
      highlights,
      options,
      out: attempt(() =>
        planAppend(highlights, {
          ...options,
          linkedIds: new Set(options.linkedIds),
          images: pairs(options.images)
        })
      )
    })),
    linkedIds: LINKED_MARKDOWN.map((markdown) => ({
      markdown,
      ids: [...linkedHighlightIds(markdown)]
    })),
    imageUrl: IMAGE_TEXTS.map((text) => ({
      text,
      url: imageHighlightUrl({ id: 1, text })
    }))
  }
}

function journalVectors(): unknown {
  return {
    day: JOURNAL_CASES.map(({ name, day }) => ({ name, books: day, out: planJournalDay(day) })),
    append: JOURNAL_CASES.map(({ name, arrivals }) => ({
      name,
      books: arrivals,
      out: planJournalAppend(arrivals)
    })),
    titles: JOURNAL_TITLES.map((title) => ({
      title,
      out: planJournalAppend([{ title, count: 1, first: '2026-10-22T00:00:00.000Z' }])
    })),
    write: JOURNAL_CASES.flatMap(({ name, day, arrivals }) =>
      [null, ...DAY_BODIES.map(({ body }) => body)].map((body, index) => ({
        name: `${name} / body ${index}`,
        body,
        day,
        arrivals,
        out: planJournalWrite(body, day, arrivals)
      }))
    ),
    dates: HIGHLIGHT_DATES.map(({ dates, timeZone }) => ({
      dates,
      timeZone,
      day: attempt(() => highlightDay(dates, timeZone)),
      instant: highlightInstant(dates)
    }))
  }
}

function readerVectors(): unknown {
  return READER_CASES.map(({ name, document, options }) => ({
    name,
    document,
    options,
    out: planReaderNote(document as ReaderDocument, {
      ...options,
      images: pairs(options.images),
      bookExternalIds: new Set(options.bookExternalIds ?? [])
    })
  }))
}

async function readerFullTextVectors(): Promise<unknown> {
  const out = []
  for (const { name, html, baseUrl } of READER_FULL_TEXT_CASES) {
    const text = await prepareReaderFullText(html, baseUrl)
    const saved = text.imageUrls.map((url, i): [string, string] => [
      url,
      `../../attachments/n1/rw-${i}.png`
    ])
    out.push({
      name,
      html,
      baseUrl,
      imageUrls: text.imageUrls,
      saved,
      rendered: text.render(new Map(saved)),
      renderedWithoutImages: text.render(new Map())
    })
  }
  return out
}

function imageVectors(): unknown {
  return IMAGE_URLS.map((url) => ({ url, stem: imageFileStem(url) }))
}

describe('readwise vectors', () => {
  it('match the committed files (MEMRY_WRITE_VECTORS=1 rewrites them)', async () => {
    const files: Record<string, unknown> = {
      'section.json': await sectionVectors(),
      'plan-note.json': planNoteVectors(),
      'plan-append.json': planAppendVectors(),
      'journal.json': journalVectors(),
      'reader.json': readerVectors(),
      'reader-full-text.json': await readerFullTextVectors(),
      'images.json': imageVectors()
    }
    const write = process.env.MEMRY_WRITE_VECTORS === '1'
    if (write) mkdirSync(DIR, { recursive: true })
    for (const [file, data] of Object.entries(files)) {
      const text = `${JSON.stringify(data, null, 2)}\n`
      const path = join(DIR, file)
      if (write) writeFileSync(path, text)
      expect(readFileSync(path, 'utf8'), `${file} drifted: rerun with MEMRY_WRITE_VECTORS=1`).toBe(
        text
      )
    }
  }, 120_000)

  it('cover the fixture books the planners are tested with', () => {
    const names = BOOK_CASES.map((c) => c.book.user_book_id)
    expect(names).toContain(FULL_BOOK.user_book_id)
    expect(names).toContain(TRICKY_BOOK.user_book_id)
  })
})
