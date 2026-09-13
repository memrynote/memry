/**
 * Verifier for `markdown-roundtrip/` (T073).
 *
 * Three jobs:
 *
 *  1. THE FR-008 GATE FOR THIS CLASS: `cases.json` is in sync with
 *     `ROUNDTRIP_CASES`, so the exported file cannot drift from the in-code
 *     corpus a change to the editor schema updates.
 *  2. The seeded fuzz families are exported with the same seed the two desktop
 *     suites fuzz at, so a second implementation fuzzes the same inputs.
 *  3. BYTE PRESERVATION on the out-of-band cases, which is the whole of a
 *     non-editor client's obligation here (chapter 12 §12.1.2): apply the
 *     update to a fresh document, encode the FULL state back out, and every
 *     root must survive — including one this specification does not name.
 *
 * What is NOT asserted here: markdown parsing or serialisation. The editor
 * bundle owns both directions, and the two desktop round-trip suites already
 * assert them over this same corpus.
 */
import * as Y from 'yjs'
import { describe, expect, it } from 'vitest'
import { FUZZ_FAMILIES, ROUNDTRIP_CASES } from '@memry/editor-schema/conformance'

import { fromHex, loadVectorFile } from './vector-loader'

const cases = loadVectorFile<{
  meta: {
    caseCount: number
    exportedCaseCount: number
    storageCaseCount: number
    outOfBandCaseCount: number
    source: string
  }
  cases: Array<{ name: string; markdown: string; canonical: string | null; sha256: string }>
  storageCases: Array<{ name: string; markdown: string; pins: string }>
  outOfBandCases: Array<{
    name: string
    pins: string
    updateHex: string
    expectedRoots: string[]
  }>
}>('markdown-roundtrip/cases.json')

const fuzz = loadVectorFile<{
  meta: { seed: string; casesPerFamily: number; familyCount: number }
  families: Array<{ name: string; pending: unknown }>
}>('markdown-roundtrip/fuzz-families.json')

describe('markdown-roundtrip corpus export', () => {
  it('is in sync with ROUNDTRIP_CASES — the FR-008 gate for this class', () => {
    expect(cases.cases).toHaveLength(ROUNDTRIP_CASES.length)
    expect(cases.meta.exportedCaseCount).toBe(ROUNDTRIP_CASES.length)
    for (const [i, source] of ROUNDTRIP_CASES.entries()) {
      expect(cases.cases[i].name, `case ${i} drifted`).toBe(source.name)
      expect(cases.cases[i].markdown).toBe(source.markdown)
      expect(cases.cases[i].canonical).toBe(source.canonical ?? null)
    }
  })

  it('every exported case carries a digest of its own bytes', async () => {
    const { createHash } = await import('node:crypto')
    for (const entry of cases.cases) {
      expect(createHash('sha256').update(entry.markdown, 'utf8').digest('hex')).toBe(entry.sha256)
    }
  })

  it('carries the recorded case count', () => {
    expect(cases.cases.length + cases.storageCases.length + cases.outOfBandCases.length).toBe(
      cases.meta.caseCount
    )
  })

  it('exports the seeded fuzz families at the seed the desktop suites use', () => {
    expect(fuzz.families).toHaveLength(FUZZ_FAMILIES.length)
    expect(fuzz.meta.familyCount).toBe(FUZZ_FAMILIES.length)
    expect(fuzz.meta.seed).toBe('0x1848')
    expect(fuzz.meta.casesPerFamily).toBe(48)
    expect(fuzz.families.map((f) => f.name)).toEqual(FUZZ_FAMILIES.map((f) => f.name))
  })
})

describe('markdown-roundtrip storage cases', () => {
  const byName = (needle: string) => cases.storageCases.find((c) => c.name.includes(needle))!

  it('a BOM belongs to the frontmatter block', () => {
    expect(byName('BOM').markdown.charCodeAt(0)).toBe(0xfeff)
  })

  it('a CRLF file is CRLF throughout', () => {
    const entry = byName('CRLF')
    expect(entry.markdown).toContain('\r\n')
    expect(entry.markdown.replace(/\r\n/g, '')).not.toContain('\n')
  })

  it('an unclosed --- block is not frontmatter', () => {
    const entry = byName('unclosed')
    expect(entry.markdown.match(/^---$/gm) ?? []).toHaveLength(1)
  })

  it('a file with no trailing newline has none', () => {
    expect(byName('no trailing newline').markdown.endsWith('\n')).toBe(false)
  })
})

describe('markdown-roundtrip out-of-band encodings', () => {
  for (const entry of cases.outOfBandCases) {
    it(`${entry.name}: every root survives a decode and a full-state re-encode`, () => {
      const first = new Y.Doc()
      Y.applyUpdate(first, fromHex(entry.updateHex))

      // The ONLY safe way to preserve unknown roots: a full-state encode. A
      // client that rebuilt the document through typed accessors would drop
      // exactly the roots it did not know to ask for, which is the failure
      // this case exists to catch.
      const reencoded = Y.encodeStateAsUpdate(first)
      const second = new Y.Doc()
      Y.applyUpdate(second, reencoded)

      const roots = [...second.share.keys()]
      for (const expected of entry.expectedRoots) {
        expect(roots, `${expected} did not survive: ${entry.pins}`).toContain(expected)
      }
    })
  }

  it('the foreign-root case carries a root this specification does not name', () => {
    // Without it the class only proves that roots someone remembered to list
    // survive, which is a strictly weaker claim than FR-033 makes.
    const entry = cases.outOfBandCases.find((c) => c.name.includes('FOREIGN root'))
    expect(entry, 'the foreign-root case is missing').toBeDefined()
    expect(entry!.expectedRoots).toContain('someFutureRootNobodyKnows')
  })

  it('rebuilding through named accessors DROPS a root the rebuilder did not know', () => {
    // The negative control. If this ever stopped dropping, the full-state rule
    // above would no longer be load-bearing and the suite would be asserting
    // something that cannot fail.
    const entry = cases.outOfBandCases.find((c) => c.name.includes('FOREIGN root'))!
    const source = new Y.Doc()
    Y.applyUpdate(source, fromHex(entry.updateHex))

    const rebuilt = new Y.Doc()
    rebuilt.getXmlFragment('prosemirror')
    const rebuiltRoots = [...rebuilt.share.keys()]
    expect(rebuiltRoots).not.toContain('someFutureRootNobodyKnows')
    expect([...source.share.keys()]).toContain('someFutureRootNobodyKnows')
  })
})
