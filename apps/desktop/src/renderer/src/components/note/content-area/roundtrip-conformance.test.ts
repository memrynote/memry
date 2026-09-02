/**
 * Renderer-pipeline half of the round-trip conformance suite (#1848), against
 * the REAL editor schema and the real remark serialization — a mocked editor
 * would pass regardless of what reaches the vault file. The corpus and its
 * reasoning live in `@memry/editor-schema/conformance`; the main half runs the
 * same corpus in `src/main/sync/blocknote-converter.roundtrip.test.ts`. Both
 * halves assert the same canonical bytes, so the two serializers agreeing with
 * the corpus is the same fact as them agreeing with each other.
 */

import { describe, expect, it, vi } from 'vitest'
import { BlockNoteEditor, type Block } from '@blocknote/core'
import {
  FUZZ_FAMILIES,
  ROUNDTRIP_CASES,
  createSeededRandom
} from '@memry/editor-schema/conformance'

// The file block's PDF preview pulls pdf.js, which touches `DOMMatrix` at
// import time and jsdom has none. Nothing else is stubbed.
vi.mock('react-pdf', () => ({
  Document: () => null,
  Page: () => null,
  pdfjs: { GlobalWorkerOptions: { workerSrc: '' } }
}))

import { editorSchema } from './editor-schema'
import { parseMarkdownPreservingBlanks, serializeBlocksPreservingBlanks } from './markdown-utils'
import { serializeMarkdownPreservingSource } from './markdown-source'
import { normalizeNoteBlocks } from './normalize-note-blocks'

const editor = BlockNoteEditor.create({ schema: editorSchema, _headless: true } as never)

// The real open→save cycle: parse, promote tokens to inline nodes exactly as
// every note surface does, serialize back. This is HOUSE STYLE, what an edited
// region writes; `roundTripPreservingSource` below is what the note hook
// actually saves, with the author's bytes recorded at load (#1915).
async function roundTrip(markdown: string): Promise<string> {
  const parsed = await parseMarkdownPreservingBlanks(editor, markdown)
  const normalized = normalizeNoteBlocks(parsed as Block[])
  return await serializeBlocksPreservingBlanks(editor, normalized as Block[])
}

async function roundTripPreservingSource(markdown: string): Promise<string> {
  const parsed = await parseMarkdownPreservingBlanks(editor, markdown)
  const normalized = normalizeNoteBlocks(parsed as Block[]) as Block[]
  const canonical = await serializeBlocksPreservingBlanks(editor, normalized)
  return serializeMarkdownPreservingSource(
    editor,
    normalized,
    canonical === markdown ? null : markdown
  )
}

describe('round-trip conformance corpus, renderer pipeline', () => {
  const cases = ROUNDTRIP_CASES.map((c) => ({ ...c, pendingIssue: c.pending?.renderer }))
  const pendingCases = cases.filter((c) => c.pendingIssue)

  it.each(cases.filter((c) => !c.pendingIssue))('$name', async ({ markdown, canonical }) => {
    const once = await roundTrip(markdown)
    expect(once, 'round-trip reaches the canonical bytes').toBe(canonical ?? markdown)
    expect(await roundTrip(once), 'second round-trip changes nothing').toBe(once)
  })

  // Broken on current main; fixed by the named sibling of epic #1843. `it.fails`
  // inverts the expectation, so the sibling landing turns these red and forces
  // the pending flag off — the case then asserts the fixed behavior forever.
  if (pendingCases.length > 0) {
    it.fails.each(pendingCases)(
      '$name (pending #$pendingIssue)',
      async ({ markdown, canonical }) => {
        const once = await roundTrip(markdown)
        expect(once, 'round-trip reaches the canonical bytes').toBe(canonical ?? markdown)
        expect(await roundTrip(once), 'second round-trip changes nothing').toBe(once)
      }
    )
  }
})

describe('source-preserving round-trip, renderer pipeline (#1915)', () => {
  const cases = ROUNDTRIP_CASES.filter((c) => !c.pending?.renderer)
  it.each(cases)('$name comes back byte-identical', async ({ markdown }) => {
    const once = await roundTripPreservingSource(markdown)
    expect(once, 'the author’s bytes come back').toBe(markdown)
    expect(await roundTripPreservingSource(once), 'second round-trip changes nothing').toBe(
      markdown
    )
  })
})

describe('round-trip fuzz, renderer pipeline', () => {
  const families = FUZZ_FAMILIES.map((f) => ({ ...f, pendingIssue: f.pending?.renderer }))

  async function assertFamily(generate: (random: () => number) => string): Promise<void> {
    const random = createSeededRandom(0x1848)
    for (let i = 0; i < 48; i++) {
      const markdown = generate(random)
      const once = await roundTrip(markdown)
      expect(once, `round-trip is identity for ${JSON.stringify(markdown)}`).toBe(markdown)
      expect(
        await roundTrip(once),
        `second round-trip changes nothing for ${JSON.stringify(markdown)}`
      ).toBe(once)
    }
  }

  const pendingFamilies = families.filter((f) => f.pendingIssue)

  it.each(families.filter((f) => !f.pendingIssue))(
    '$name stay byte-identical across 48 seeded cases',
    async ({ generate }) => assertFamily(generate)
  )

  if (pendingFamilies.length > 0) {
    it.fails.each(pendingFamilies)(
      '$name stay byte-identical across 48 seeded cases (pending #$pendingIssue)',
      async ({ generate }) => assertFamily(generate)
    )
  }
})
