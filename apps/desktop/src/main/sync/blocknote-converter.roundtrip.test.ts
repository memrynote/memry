/**
 * Main-pipeline half of the round-trip conformance suite (#1848). The corpus
 * and the reasoning live in `@memry/editor-schema/conformance`; the renderer
 * half runs the same corpus in
 * `src/renderer/src/components/note/content-area/roundtrip-conformance.test.ts`.
 * Both halves assert the same canonical bytes, so the two serializers agreeing
 * with the corpus is the same fact as them agreeing with each other.
 */

import { describe, expect, it } from 'vitest'
import { readFileSync, readdirSync } from 'fs'
import path from 'path'
import * as Y from 'yjs'
import { CRDT_FRAGMENT_NAME } from '@memry/contracts/ipc-crdt'
import {
  FUZZ_FAMILIES,
  ROUNDTRIP_CASES,
  createSeededRandom
} from '@memry/editor-schema/conformance'
import { markdownToYFragment, yDocToMarkdown } from './blocknote-converter'
import { parseNote } from '../vault/frontmatter'

async function roundTrip(markdown: string): Promise<string> {
  const doc = new Y.Doc()
  const ok = await markdownToYFragment(markdown, doc.getXmlFragment(CRDT_FRAGMENT_NAME))
  expect(ok, 'markdown reached the shared doc').toBe(true)
  const out = await yDocToMarkdown(doc)
  expect(out, 'the doc serialized back at all').not.toBeNull()
  return out as string
}

describe('round-trip conformance corpus, main pipeline', () => {
  const cases = ROUNDTRIP_CASES.map((c) => ({ ...c, pendingIssue: c.pending?.main }))
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

describe('round-trip fuzz, main pipeline', () => {
  const families = FUZZ_FAMILIES.map((f) => ({ ...f, pendingIssue: f.pending?.main }))

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

describe('golden vault round-trip fixtures, main pipeline', () => {
  // The frontmatter-level byte-preservation of these files is asserted in
  // src/main/vault/byte-preservation.golden.test.ts over the same directory;
  // this suite additionally pushes their bodies through the CRDT converter.
  const fixturesDir = path.join(__dirname, '..', 'vault', '__fixtures__', 'golden-vault')
  const fixtures = readdirSync(fixturesDir).filter((f) => f.startsWith('roundtrip-'))

  it('the token fixtures exist', () => {
    expect(fixtures.length).toBeGreaterThanOrEqual(4)
  })

  it.each(fixtures)('%s body survives the converter round-trip byte-identical', async (name) => {
    const filePath = path.join(fixturesDir, name)
    const raw = readFileSync(filePath, 'utf-8')
    const markdown = parseNote(raw, filePath).content.replace(/^\n+/, '').replace(/\n$/, '')
    const once = await roundTrip(markdown)
    expect(once, 'round-trip is identity').toBe(markdown)
    expect(await roundTrip(once), 'second round-trip changes nothing').toBe(once)
  })
})
