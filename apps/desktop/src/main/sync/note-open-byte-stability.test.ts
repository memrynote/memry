/**
 * Opening a note must not rewrite it (#1434, phase 3 of #1427).
 *
 * ## The loop this file exists to close
 *
 * On the collaborative path the two processes hold different ideas of what a
 * wiki link IS. Main parses the vault file into the shared Y.Doc
 * (`crdt-provider.seedFromMarkdown` -> `markdownToYFragment`) with a `wikiLink`
 * spec that has NO `parse` rule, so `[[X]]` arrives as plain TEXT. The renderer
 * then promotes that text into a `wikiLink` NODE on the first change event
 * (`normalizeWikiLinks`, called from `use-editor-sync.ts`'s `handleChange`,
 * which is not gated on collaboration). Write-back serializes the node back to
 * `[[X]]` text. Before #1428 this "stabilised" only because main's schema had
 * no `wikiLink` at all and y-prosemirror deleted the node outright; now that
 * main can represent it, the round trip has to be shown to CONVERGE.
 *
 * Byte stability is the user-visible contract — opening a note may not modify
 * it — and it is what protects Obsidian fidelity.
 *
 * ## What this file drives for real, and what it stands in for
 *
 * REAL: `markdownToYFragment` (the parser the collaborative path actually
 * uses), `yFragmentToBlocks` / `blocksToYFragment`, `yDocToMarkdown`, the
 * renderer's own `normalizeWikiLinks`, and the whole of `performWriteback` —
 * including its byte-compare — against real `vault/frontmatter`,
 * `vault/file-ops` and real files in a temp vault.
 *
 * STOOD IN FOR: the BlockNote editor instance and y-prosemirror's ProseMirror
 * <-> Y.Doc binding. `applyRendererPromotion` below reads the fragment as
 * blocks, runs the renderer's normalizer, and writes the result back — which is
 * what `editor.replaceBlocks(editor.document, normalized.blocks)` does through
 * the binding, minus the minimal-delta diffing (irrelevant to the resulting
 * bytes). The other half of that seam — that a REAL mounted editor bound to a
 * REAL Y.Doc promotes exactly once and leaves the node in the doc — is driven
 * in the renderer suite, in
 * `renderer/src/components/note/content-area/wiki-link-collab-promotion.test.ts`.
 *
 * ## Why the renderer import is here rather than the other way round
 *
 * `pnpm check:architecture` scans renderer SOURCE files for `@main/*` imports;
 * it never scans main for renderer imports, and it skips `*.test.ts` in both
 * directions (`getFilesForRoot` filters `isTestFile`). So the choice is not
 * "allowed vs forbidden" but "which import keeps the type-check honest". Only
 * this one does: `tsconfig.test.node.json` compiles `wiki-link-utils.ts` (three
 * DOM-free modules and `@memry/editor-schema/inline`) without complaint, while
 * a renderer test importing `blocknote-converter` would drag `node:crypto`,
 * `electron-log` and the databases into `tsconfig.test.web.json`, which carries
 * neither the node types nor the includes for them.
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as Y from 'yjs'
import type { Block } from '@blocknote/core'
import { CRDT_FRAGMENT_NAME } from '@memry/contracts/ipc-crdt'
import { writeMarkdownSourceToYDoc } from '@memry/shared/markdown-source'

// The renderer's promotion rule. Imported from source on purpose: a copy of it
// here would converge with itself and prove nothing.
import { normalizeWikiLinks } from '../../renderer/src/components/note/content-area/wiki-link-utils'

const mocks = vi.hoisted(() => ({
  vaultRoot: '',
  noteRow: null as Record<string, unknown> | null,
  sent: [] as Array<{ channel: string; payload: unknown }>,
  atomicWrites: [] as Array<{ absolutePath: string; content: string }>,
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }
}))

vi.mock('electron', () => ({
  BrowserWindow: {
    getAllWindows: () => [
      {
        isDestroyed: () => false,
        webContents: {
          send: (channel: string, payload: unknown) => mocks.sent.push({ channel, payload })
        }
      }
    ]
  }
}))

vi.mock('../lib/logger', () => ({ createLogger: () => mocks.logger }))

// crdt-provider itself reaches for `app.getPath` and the CRDT store; write-back
// only ever asks it "is there a newer doc for this note?".
vi.mock('./crdt-provider', () => ({
  getCrdtProvider: () => ({ getDoc: () => undefined, close: vi.fn() })
}))

vi.mock('../telemetry/diagnostics', () => ({ trackMainError: vi.fn(), trackMainLog: vi.fn() }))

vi.mock('../database/client', () => ({
  getIndexDatabase: () => ({ kind: 'index-db' }),
  getDatabase: () => ({ kind: 'data-db' })
}))

vi.mock('@main/database/queries/notes', () => ({
  getNoteCacheById: () => mocks.noteRow,
  getNoteCacheByPath: () => mocks.noteRow
}))

vi.mock('@memry/storage-data', () => ({ getNoteMetadataById: () => null }))

// The real one re-measures the bytes it just wrote, and the write-back's guard
// reads that hash on the next pass. Stubbing it to nothing would make a second
// open look like an external edit and stop writing.
vi.mock('../vault/note-sync', () => ({
  syncNoteToCache: vi.fn((_db: unknown, note: { fileContent: string }) => {
    mocks.noteRow = { ...mocks.noteRow, contentHash: generateContentHash(note.fileContent) }
  }),
  deleteNoteFromCache: vi.fn()
}))

vi.mock('../projections', () => ({ flushProjectionEvents: vi.fn() }))

vi.mock('@memry/app-core/reminders', () => ({ createRemindersService: () => ({}) }))

vi.mock('../notes/note-date-reminders', () => ({
  syncNoteDateReminders: vi.fn(),
  clearNoteDateReminders: vi.fn()
}))

vi.mock('./local-mutations', () => ({
  enqueueLocalSyncCreate: vi.fn(),
  enqueueLocalSyncDelete: vi.fn(),
  enqueueLocalSyncUpdate: vi.fn()
}))

// Real path math and real snapshots would need the vault singleton and the
// index DB; the note's absolute path is the only thing write-back needs here.
vi.mock('../vault/notes', () => ({
  getDefaultNoteDir: () => path.join(mocks.vaultRoot, 'notes'),
  toRelativePath: (absolute: string) => path.relative(mocks.vaultRoot, absolute),
  toAbsolutePath: (relative: string) => path.join(mocks.vaultRoot, relative),
  maybeCreateSignificantSnapshot: () => null
}))

// REAL file ops, wrapped so the suite can assert that write-back never wrote —
// "the file is byte-identical" and "no write happened" are different claims,
// and the second is the one the user feels (no mtime churn, no snapshot, no
// sync push).
vi.mock('../vault/file-ops', async () => {
  const actual = await vi.importActual<typeof import('../vault/file-ops')>('../vault/file-ops')
  return {
    ...actual,
    atomicWrite: async (absolutePath: string, content: string) => {
      mocks.atomicWrites.push({ absolutePath, content })
      return actual.atomicWrite(absolutePath, content)
    }
  }
})

import {
  blocksToYFragment,
  findUnrepresentableNodes,
  markdownToYFragment,
  yDocToMarkdown,
  yFragmentToBlocks
} from './blocknote-converter'
import { generateContentHash, parseNote } from '../vault/frontmatter'
import {
  cancelPendingWritebacks,
  flushPendingWritebacks,
  getWritebackDebugState,
  resetWritebackState,
  scheduleWriteback
} from './crdt-writeback'

const NOTE_ID = 'byte-stability-note'
const REL_PATH = path.join('notes', 'Byte Stability.md')

/**
 * Every fixture the issue names, plus the block shapes whose `parse` rules were
 * the sharp edge in #1428: a wiki link is one element inside a list item, a
 * quote and a table cell, and a text-matching parse claims the whole element.
 *
 * Wiki links carrying an inline MARK are in here as of #1439. They used to be
 * deliberately absent, because opening the note DELETED the mark from the vault
 * file; the marks now ride in the node's props when the link is the whole
 * styled run, and the promotion declines outright when it is not. Both halves
 * are fixtures below — the acceptance table of #1439 is rows 1-5 of this list
 * plus the unmarked `[[Wiki Link]]` guard.
 */
const FIXTURES: ReadonlyArray<readonly [string, string]> = [
  // #1439's acceptance table, in order. The first three promote and carry the
  // mark in props; the fourth is the narrowing — the link sits inside a longer
  // marked phrase, so it is left as literal text and the file is untouched.
  ['bold around the whole link', '**[[Meeting]]**'],
  ['strikethrough around the whole link', '~~[[Meeting]]~~'],
  ['italic around the whole link', '*[[A]]*'],
  ['a wiki link inside a marked phrase', '~~Cancelled: [[Meeting]]~~'],
  ['a wiki link inside a bolded sentence', '**See [[Roadmap]] for details**'],
  ['an aliased link, marked', '**[[Roadmap|the plan]]**'],
  ['a wiki link in a sentence', 'See [[Wiki Link]] for details.'],
  ['a wiki link alone in its block', '[[Wiki Link]]'],
  ['an aliased wiki link', 'See [[Roadmap|the plan]] today.'],
  ['a wiki link per list item', '- [[A]]\n- [[B]]'],
  ['a wiki link in a quote', '> [[Quoted]]'],
  // BlockNote serializes inline content inside a TABLE through the spec's
  // `render`, not `toExternalHTML`, so main's serialization-only variant has to
  // emit the marks from both halves or a marked link in a cell loses them.
  ['a marked wiki link in a table cell', '| **[[A]]** | b |\n| --------- | - |\n| c         | d |'],
  // Table cells are the case the server spec's `render` has to get right —
  // BlockNote serializes inline content inside a table through `render`, not
  // `toExternalHTML`. The separator row is written pre-padded because remark
  // normalizes `| --- |` to the column width on the way out; that is a
  // pre-existing normalization of the markdown serializer, not this loop.
  ['a wiki link in a table cell', '| [[A]] | b |\n| ----- | - |\n| c     | d |'],
  ['a hash tag', 'Tagged #hashtag here.'],
  ['a date mention token', '((date:eyJhbmNob3JJZCI6ImExIn0)) leftover token.'],
  ['a callout', '> [!info]\n> Heads up'],
  [
    'the whole set in one note',
    [
      '# Weekly',
      '',
      'See [[Wiki Link]] and #hashtag on ((date:eyJhbmNob3JJZCI6ImExIn0)).',
      '',
      '- [[A]]',
      '- [[B]]',
      '',
      '> [!info]',
      '> Heads up'
    ].join('\n')
  ]
]

function fragmentOf(doc: Y.Doc): Y.XmlFragment {
  return doc.getXmlFragment(CRDT_FRAGMENT_NAME)
}

/** How many `wikiLink` elements the LIVE doc holds right now. */
function countWikiLinkNodes(doc: Y.Doc): number {
  let count = 0
  const visit = (node: Y.XmlFragment | Y.XmlElement): void => {
    for (const child of node.toArray()) {
      const element = child as Y.XmlElement
      if (typeof element.nodeName !== 'string') continue
      if (element.nodeName === 'wikiLink') count++
      visit(element)
    }
  }
  visit(fragmentOf(doc))
  return count
}

/**
 * `handleChange`'s first act, applied to the shared doc.
 *
 * `use-editor-sync.ts` runs `normalizeWikiLinks(editor.document)` on every
 * change and, when it changed anything, calls `editor.replaceBlocks` — which
 * y-prosemirror turns into a write on the bound fragment. Returns whether the
 * renderer would have replaced the document, which is the "did it promote"
 * signal the convergence question is about.
 */
async function applyRendererPromotion(doc: Y.Doc): Promise<boolean> {
  const fragment = fragmentOf(doc)
  const blocks = await yFragmentToBlocks(fragment)
  expect(blocks).not.toBeNull()

  const normalized = normalizeWikiLinks(blocks as Block[])
  if (!normalized.didChange) return false

  doc.transact(() => {
    fragment.delete(0, fragment.length)
    blocksToYFragment(normalized.blocks, fragment)
  })
  return true
}

/** `crdt-provider.seedFromMarkdown`: parse the vault file, but only once. */
async function openNote(absolutePath: string): Promise<Y.Doc> {
  const doc = new Y.Doc()
  const raw = fs.readFileSync(absolutePath, 'utf8')
  const parsed = parseNote(raw, absolutePath)
  const ok = await markdownToYFragment(parsed.content, fragmentOf(doc), REL_PATH)
  expect(ok).toBe(true)
  // The seed records the hash of the bytes it built the doc from, so the
  // write-back knows this file has been read. Without it the write-back
  // correctly refuses to touch a file nothing here has looked at (#1909), and
  // every case in this file would pass by never saving at all.
  if (mocks.noteRow) mocks.noteRow = { ...mocks.noteRow, contentHash: generateContentHash(raw) }
  return doc
}

/** Arm the real debounced write-back and run it now. */
async function runWriteback(doc: Y.Doc): Promise<void> {
  scheduleWriteback(NOTE_ID, doc)
  await flushPendingWritebacks()
}

function seedVaultNote(body: string): string {
  const absolutePath = path.join(mocks.vaultRoot, REL_PATH)
  fs.mkdirSync(path.dirname(absolutePath), { recursive: true })
  fs.writeFileSync(absolutePath, body, 'utf8')
  return absolutePath
}

beforeEach(() => {
  mocks.vaultRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'memry-byte-stability-'))
  mocks.sent.length = 0
  mocks.atomicWrites.length = 0
  mocks.noteRow = {
    id: NOTE_ID,
    path: REL_PATH,
    title: 'Byte Stability',
    createdAt: '2026-01-01T00:00:00.000Z',
    localOnly: false,
    emoji: null,
    fileType: 'md',
    date: null
  }
  vi.stubEnv('NODE_ENV', 'test')
})

afterEach(() => {
  cancelPendingWritebacks()
  resetWritebackState()
  vi.unstubAllEnvs()
  fs.rmSync(mocks.vaultRoot, { recursive: true, force: true })
})

describe('opening a note with collaboration active does not rewrite it', () => {
  it.each(FIXTURES)('%s', async (_name, body) => {
    // #given a vault note as it exists on disk today
    const absolutePath = seedVaultNote(body)

    // #when it is opened on the collaborative path and write-back runs
    const doc = await openNote(absolutePath)
    await applyRendererPromotion(doc)
    await runWriteback(doc)

    // #then the file was not written at all, and its bytes are unchanged
    expect(mocks.atomicWrites).toEqual([])
    expect(fs.readFileSync(absolutePath, 'utf8')).toBe(body)
    expect(getWritebackDebugState(NOTE_ID)?.lastMarkdown).toBe(body)
  })
})

describe('repeated open -> write-back cycles converge', () => {
  /**
   * Six, not two. Two passes cannot tell "converged" apart from "grows by a
   * constant", and a length that repeats once can still be the second term of a
   * sequence that moves again on the third. The #1439 attempt this one replaces
   * grew by exactly four characters per pass (26→30→34→38→42→46).
   */
  const PASSES = 6

  it.each(FIXTURES)('%s is a fixed point from the first pass', async (_name, body) => {
    // #given
    const absolutePath = seedVaultNote(body)
    const lengths: number[] = [body.length]

    // #when the note is closed and reopened five times, each open re-seeding the
    // shared doc from the file exactly as a fresh device would
    for (let pass = 0; pass < PASSES; pass++) {
      const doc = await openNote(absolutePath)
      await applyRendererPromotion(doc)
      await runWriteback(doc)
      lengths.push(fs.readFileSync(absolutePath, 'utf8').length)
    }

    // #then every pass produced the same bytes, and none of them wrote
    expect(lengths).toEqual(Array<number>(PASSES + 1).fill(body.length))
    expect(fs.readFileSync(absolutePath, 'utf8')).toBe(body)
    expect(mocks.atomicWrites).toEqual([])
  })

  it('a doc that stays open converges after one promotion', async () => {
    // #given a note held open, with the renderer firing change after change —
    // the tab is never closed, so the doc is seeded once
    const body = 'See [[Wiki Link]] and #hashtag today.'
    const absolutePath = seedVaultNote(body)
    const doc = await openNote(absolutePath)

    // #when
    const promotions: boolean[] = []
    for (let pass = 0; pass < PASSES; pass++) {
      promotions.push(await applyRendererPromotion(doc))
      await runWriteback(doc)
    }

    // #then only the first change promotes; the rest find a document that is
    // already in canonical form, so the loop terminates instead of ping-ponging
    expect(promotions).toEqual([true, false, false, false, false, false])
    expect(fs.readFileSync(absolutePath, 'utf8')).toBe(body)
    expect(mocks.atomicWrites).toEqual([])
  })
})

/**
 * #1454. The fixtures above pass because nothing puts a tag in the doc's tag
 * array; the app used to, and that is where the rewrite came from. Write-back
 * treats `doc.getArray('tags')` as authoritative for the file's `tags:` block
 * (`mergeFrontmatter`), and the watcher used to seed it with `syncResult.tags`
 * — the INDEX's tag list, which merges the body's `#hashtag`s in. So a note
 * whose only tag was in its body gained a frontmatter block on first open.
 *
 * These two tests pin both halves: what a seeded array does to the file, and
 * that the file's own `tags:` block round-trips through it untouched.
 */
describe('the tag array decides whether opening a note rewrites its frontmatter', () => {
  /** What `CrdtProvider.initForNote` does with the tags it is handed. */
  function seedTagArray(doc: Y.Doc, tags: string[]): void {
    const tagArray = doc.getArray('tags')
    doc.transact(() => {
      if (tags.length > 0) tagArray.push(tags)
    })
  }

  it('a body tag in the array injects a tags: block into a file that had none', async () => {
    // #given the note from the issue: one inline hash tag, no frontmatter
    const body = 'Tagged #hashtag here.'
    const absolutePath = seedVaultNote(body)
    const doc = await openNote(absolutePath)

    // #when the doc is seeded the way the merged index tag list would seed it
    seedTagArray(doc, ['hashtag'])
    await runWriteback(doc)

    // #then opening the note modified it. This is the mechanism #1454 removes —
    // kept here because the fix is "never put a body tag in this array", and
    // that is only meaningful if what the array does is on record.
    expect(mocks.atomicWrites).toHaveLength(1)
    const rewritten = fs.readFileSync(absolutePath, 'utf8')
    expect(rewritten).toContain('tags:')
    expect(rewritten).toContain('- hashtag')
    expect(rewritten).not.toBe(body)
  })

  it('a tags: block the file already declares survives a round trip unwritten', async () => {
    // #given a note that declares its own tags — the array is seeded from the
    // frontmatter, which is exactly what it holds after the fix
    // No blank line after the closing `---`: that is the form `serializeNote`
    // writes, and this test is about tags, not about frontmatter spacing.
    const body = ['---', 'tags:', '  - Declared', '---', 'Tagged #hashtag here.'].join('\n')
    const absolutePath = seedVaultNote(body)
    const doc = await openNote(absolutePath)

    // #when
    seedTagArray(doc, ['Declared'])
    await runWriteback(doc)

    // #then nothing was written: the declared tag is already in the file, and
    // the body tag never entered the array to be promoted
    expect(mocks.atomicWrites).toEqual([])
    expect(fs.readFileSync(absolutePath, 'utf8')).toBe(body)
  })
})

describe('the canonical form of a wiki link inside the CRDT', () => {
  it('main seeds the shared doc with TEXT, not a node', async () => {
    // #given / #when main parses the vault file for the collaborative path
    const absolutePath = seedVaultNote('See [[Wiki Link]] for details.')
    const doc = await openNote(absolutePath)

    // #then the doc holds no wikiLink node — main's spec has no `parse` rule,
    // and giving it one would let a text-matching rule claim the whole `<li>` /
    // `<blockquote>` / `<td>` around the link (#1428)
    expect(countWikiLinkNodes(doc)).toBe(0)
    const blocks = (await yFragmentToBlocks(fragmentOf(doc))) as Block[]
    expect(JSON.stringify(blocks)).toContain('[[Wiki Link]]')
  })

  it('the renderer promotes it to a node, and that is what the doc keeps', async () => {
    // #given
    const absolutePath = seedVaultNote('See [[Wiki Link]] for details.')
    const doc = await openNote(absolutePath)

    // #when
    expect(await applyRendererPromotion(doc)).toBe(true)

    // #then the NODE is the doc's canonical form and the TEXT is the file's
    expect(countWikiLinkNodes(doc)).toBe(1)
    expect(await yDocToMarkdown(doc)).toBe('See [[Wiki Link]] for details.')
  })

  it('reopening a doc that already holds the node does not re-promote it', async () => {
    // #given a note whose shared doc survived the close (the CRDT store keeps
    // it, so `seedFromMarkdown` early-returns on a non-empty fragment)
    const absolutePath = seedVaultNote('See [[Wiki Link]] for details.')
    const doc = await openNote(absolutePath)
    await applyRendererPromotion(doc)

    // #when the note is reopened and the editor fires its first change
    const reopened = new Y.Doc()
    Y.applyUpdate(reopened, Y.encodeStateAsUpdate(doc))
    expect(fragmentOf(reopened).length).toBeGreaterThan(0)

    // #then there is nothing left to promote: a `wikiLink` node carries its
    // target in props, so `[[` never reappears in the document JSON
    expect(await applyRendererPromotion(reopened)).toBe(false)
    await runWriteback(reopened)
    expect(mocks.atomicWrites).toEqual([])
  })
})

describe('write-back does not delete a wiki link from the shared doc', () => {
  it('serializing leaves the live doc untouched', async () => {
    // #given a doc in the state the renderer leaves it in
    const absolutePath = seedVaultNote('See [[Wiki Link]] for details.')
    const doc = await openNote(absolutePath)
    await applyRendererPromotion(doc)
    expect(countWikiLinkNodes(doc)).toBe(1)

    // #when the whole write-back path runs, twice
    const updates: Uint8Array[] = []
    doc.on('update', (update: Uint8Array) => updates.push(update))
    await runWriteback(doc)
    expect(countWikiLinkNodes(doc)).toBe(1)
    await runWriteback(doc)

    // #then the node is still there and the doc emitted nothing at all. This is
    // the #1428 regression in its exact shape: y-prosemirror answers a node name
    // its schema cannot build by DELETING the element from the doc, and that
    // delete replicates to every device.
    expect(countWikiLinkNodes(doc)).toBe(1)
    expect(updates).toEqual([])
    expect(findUnrepresentableNodes(doc)).toEqual([])
  })

  it('reading the live fragment as blocks leaves the node in place', async () => {
    // #given — `yFragmentToBlocks` is the one converter entry point that reads
    // the LIVE fragment rather than a detached snapshot, so it is where a schema
    // gap would do its damage
    const absolutePath = seedVaultNote('- [[A]]\n- [[B]]')
    const doc = await openNote(absolutePath)
    await applyRendererPromotion(doc)
    expect(countWikiLinkNodes(doc)).toBe(2)

    // #when
    const blocks = await yFragmentToBlocks(fragmentOf(doc))

    // #then
    expect(blocks).toHaveLength(2)
    expect(countWikiLinkNodes(doc)).toBe(2)
  })
})

/**
 * #1439's acceptance table, driven end to end and asserted as exact strings.
 *
 * Before this landed, a mark on a wiki link was DELETED from the vault file the
 * first time the note was opened — verified at the time against a control run
 * with the promotion step removed, which was flat in every row:
 *
 *   `**[[Meeting]]**`             -> `[[Meeting]]`                 bold DELETED
 *   `~~[[Meeting]]~~`             -> `[[Meeting]]`                 strike DELETED
 *   `*[[A]]*`                     -> `[[A]]`                       italic DELETED
 *   `~~Cancelled: [[Meeting]]~~`  -> `~~Cancelled: ~~[[Meeting]]`  mark BROKEN
 *
 * The fourth was worse than its byte count suggested: GFM requires a closing
 * `~~` not be preceded by whitespace, so `~~Cancelled: ~~` is strikethrough
 * nowhere and the note showed four literal tildes.
 *
 * All five rows are now fixed points from pass zero. The cost is deliberate:
 * the link inside a longer marked phrase gets no chip, because promoting it
 * there is what produced markdown GFM cannot parse.
 */
describe('a marked wiki link is a fixed point (#1439)', () => {
  const PASSES = 6

  it.each([
    ['bold around the whole link', '**[[Meeting]]**'],
    ['strikethrough around the whole link', '~~[[Meeting]]~~'],
    ['italic around the whole link', '*[[A]]*'],
    ['a link inside a longer struck phrase', '~~Cancelled: [[Meeting]]~~'],
    // The byte-stability guard: the unmarked link is what every existing vault
    // is full of, and it must be untouched by all of the above.
    ['an unmarked link', '[[A]]']
  ])('%s is unchanged after six opens', async (_name, body) => {
    // #given the note as it sits on disk
    const absolutePath = seedVaultNote(body)
    const lengths: number[] = [body.length]
    const contents: string[] = []

    // #when it is opened and written back six times
    for (let pass = 0; pass < PASSES; pass++) {
      const doc = await openNote(absolutePath)
      await applyRendererPromotion(doc)
      await runWriteback(doc)
      const current = fs.readFileSync(absolutePath, 'utf8')
      lengths.push(current.length)
      contents.push(current)
    }

    // #then every pass produced the seed bytes exactly, and nothing was written
    expect(contents).toEqual(Array<string>(PASSES).fill(body))
    expect(lengths).toEqual(Array<number>(PASSES + 1).fill(body.length))
    expect(mocks.atomicWrites).toEqual([])
  })

  it('the link is still a chip when the mark covers the whole run', async () => {
    // #given
    const absolutePath = seedVaultNote('**[[Meeting]]**')

    // #when
    const doc = await openNote(absolutePath)
    expect(await applyRendererPromotion(doc)).toBe(true)

    // #then the doc holds a real node — the point of carrying the marks in
    // props rather than declining everywhere — and it writes the seed bytes
    expect(countWikiLinkNodes(doc)).toBe(1)
    expect(await yDocToMarkdown(doc)).toBe('**[[Meeting]]**')
  })

  it('the link inside a longer marked phrase is deliberately NOT promoted', async () => {
    // #given
    const absolutePath = seedVaultNote('~~Cancelled: [[Meeting]]~~')

    // #when
    const doc = await openNote(absolutePath)

    // #then nothing to promote: splitting the strike run is what emitted
    // `~~Cancelled: ~~~~[[Meeting]]~~`, four more characters on every pass. The
    // file wins over the chip.
    expect(await applyRendererPromotion(doc)).toBe(false)
    expect(countWikiLinkNodes(doc)).toBe(0)
    expect(await yDocToMarkdown(doc)).toBe('~~Cancelled: [[Meeting]]~~')
  })
})

describe('known non-convergence, pinned not endorsed', () => {
  it('a note carrying CriticMarkup review marks is rewritten on first open', async () => {
    // #given review marks live in the Y.Doc, not in the fragment, and write-back
    // re-serializes them onto the body. That round trip is not byte-identical.
    let current = 'Plain {==marked==} and {>>note<<} with [[A]].'
    const absolutePath = seedVaultNote(current)
    const lengths: number[] = [current.length]

    // #when opened five times
    for (let pass = 0; pass < 5; pass++) {
      const doc = await openNote(absolutePath)
      await applyRendererPromotion(doc)
      await runWriteback(doc)
      current = fs.readFileSync(absolutePath, 'utf8')
      lengths.push(current.length)
    }

    // #then one rewrite, then a fixed point. Pinned so that dropping
    // `serializeCriticMarkup` from write-back — which deletes every review
    // comment from the note — cannot pass unnoticed the way it did before.
    expect(lengths).toEqual([45, 93, 93, 93, 93, 93])
    expect(current).toContain('marked')
    expect(current).toContain('note')
  })

  /**
   * `code` on a wiki link is the one mark that cannot round-trip, and the cause
   * predates this node: BlockNote's markdown PARSER drops every other mark off
   * a run that also carries inline code, so `` `[[A]]` `` parses back as a run
   * of `{ code: true }` and the outer emphasis is gone before promotion ever
   * runs. `` `[[A]]` `` alone is stable; combined with emphasis the DOC loses
   * the bold. Since #1915 the file the user never edited keeps its bytes
   * regardless; the loss is what an edit to that region would write. Pinned
   * as a limitation, not endorsed as correct.
   */
  it('inline code around a link is stable; code combined with bold is flattened in the doc, not the file', async () => {
    // #given
    const stable = seedVaultNote('`[[A]]`')
    const stableDoc = await openNote(stable)
    await applyRendererPromotion(stableDoc)
    await runWriteback(stableDoc)

    // #then code alone holds its bytes
    expect(fs.readFileSync(stable, 'utf8')).toBe('`[[A]]`')
    expect(mocks.atomicWrites).toEqual([])

    // #when the same link also carries bold — the parser flattens it on the way
    // IN, so what reaches the doc is already `{ code: true }` only
    const flattened = seedVaultNote('**`[[A]]`**')
    const doc = await openNote(flattened)
    await applyRendererPromotion(doc)
    await runWriteback(doc)

    // #then the untouched file keeps the author's bytes and nothing is written
    expect(fs.readFileSync(flattened, 'utf8')).toBe('**`[[A]]`**')
    expect(mocks.atomicWrites).toEqual([])

    // #and the document alone, what an edit there would write, has lost the bold
    const houseStyle = new Y.Doc()
    Y.applyUpdate(houseStyle, Y.encodeStateAsUpdate(doc))
    writeMarkdownSourceToYDoc(houseStyle, null)
    expect(await yDocToMarkdown(houseStyle)).toBe('`[[A]]`')
  })
})
