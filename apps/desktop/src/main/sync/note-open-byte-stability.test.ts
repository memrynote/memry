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

vi.mock('../vault/note-sync', () => ({
  syncNoteToCache: vi.fn(),
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
import { parseNote } from '../vault/frontmatter'
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
 * Deliberately absent: any wiki link carrying an inline MARK. That whole class
 * does not round-trip — see the `#1439` cases at the bottom of this file, which
 * pin the current behaviour without asserting it is correct. The fixtures here
 * gate the cases that DO converge; do not read their green as covering marks.
 */
const FIXTURES: ReadonlyArray<readonly [string, string]> = [
  ['a wiki link in a sentence', 'See [[Wiki Link]] for details.'],
  ['a wiki link alone in its block', '[[Wiki Link]]'],
  ['an aliased wiki link', 'See [[Roadmap|the plan]] today.'],
  ['a wiki link per list item', '- [[A]]\n- [[B]]'],
  ['a wiki link in a quote', '> [[Quoted]]'],
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
   * Five, not two. Two passes cannot tell "converged" apart from "grows by a
   * constant", and a length that repeats once can still be the second term of a
   * sequence that moves again on the third.
   */
  const PASSES = 5

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
    expect(promotions).toEqual([true, false, false, false, false])
    expect(fs.readFileSync(absolutePath, 'utf8')).toBe(body)
    expect(mocks.atomicWrites).toEqual([])
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

describe('known non-convergence, pinned not endorsed', () => {
  /**
   * #1439, and it is a CLASS, not one shape. BlockNote's
   * `CustomInlineContentFromConfig` has no `styles` field, so the promotion has
   * nowhere to put a mark and drops it. Verified against a control run with the
   * promotion step removed — every one of these is flat without it:
   *
   *   `**[[Meeting]]**`             -> `[[Meeting]]`                 mark DELETED
   *   `~~[[Meeting]]~~`             -> `[[Meeting]]`                 mark DELETED
   *   `*[[A]]*`                     -> `[[A]]`                       mark DELETED
   *   `~~Cancelled: [[Meeting]]~~`  -> `~~Cancelled: ~~[[Meeting]]`  mark BROKEN
   *
   * The last one is worse than its byte count suggests: GFM requires a closing
   * `~~` not be preceded by whitespace, so `~~Cancelled: ~~` is strikethrough
   * nowhere and the note ends up showing four literal tildes. Bold survives the
   * same shape only because the serializer emits `&#x20;` entities around it.
   *
   * Each is a single rewrite and stable afterwards. Blocked on a product
   * decision, so these assert what happens today, not what should.
   */
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

  it.each([
    ['bold around the whole link', '**[[Meeting]]**', '[[Meeting]]'],
    ['strikethrough around the whole link', '~~[[Meeting]]~~', '[[Meeting]]'],
    ['italic around the whole link', '*[[A]]*', '[[A]]']
  ])('%s loses the mark on first open, then holds', async (_name, seed, expected) => {
    // #given a note whose wiki link carries a mark
    let current = seed
    const absolutePath = seedVaultNote(current)

    // #when opened five times
    const results: string[] = []
    for (let pass = 0; pass < 5; pass++) {
      const doc = await openNote(absolutePath)
      await applyRendererPromotion(doc)
      await runWriteback(doc)
      current = fs.readFileSync(absolutePath, 'utf8')
      results.push(current)
    }

    // #then the mark is gone after the first open and never comes back
    expect(results[0]).toBe(expected)
    expect(new Set(results).size).toBe(1)
  })

  it('a wiki link inside a marked phrase is rewritten once, then holds', async () => {
    // #given
    let current = '~~Cancelled: [[Meeting]]~~'
    const lengths: number[] = [current.length]

    // #when
    const absolutePath = seedVaultNote(current)
    for (let pass = 0; pass < 5; pass++) {
      const doc = await openNote(absolutePath)
      await applyRendererPromotion(doc)
      await runWriteback(doc)
      current = fs.readFileSync(absolutePath, 'utf8')
      lengths.push(current.length)
    }

    // #then the first open rewrites the file, and every open after it is a
    // no-op — the damage is a single rewrite, not unbounded growth
    expect(current).toBe('~~Cancelled: ~~[[Meeting]]')
    expect(lengths).toEqual([26, 26, 26, 26, 26, 26])
    expect(mocks.atomicWrites).toHaveLength(1)
  })
})
