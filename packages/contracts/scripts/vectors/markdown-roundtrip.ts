/**
 * Class: markdown round-trip corpus (`markdown-roundtrip/`), 120 cases plus 6
 * seeded fuzz families.
 *
 * THE CORPUS ALREADY EXISTS IN CODE and this class exports it rather than
 * starting over: `packages/editor-schema/src/conformance.ts` holds 110
 * `ROUNDTRIP_CASES` and 6 `FUZZ_FAMILIES`, whose bytes are produced by calling
 * the production serialisers, so they already satisfy the
 * "comes from production code" rule. Two desktop suites consume them today.
 *
 * The generator adds nine cases the existing corpus does not cover because
 * they are about the STORAGE layer rather than the editor: four frontmatter
 * and EOL cases, and five out-of-band-encoding cases carried as Y updates.
 *
 * The verifier asserts `cases.json` is in sync with `ROUNDTRIP_CASES`, so the
 * exported file cannot drift from the in-code corpus. That is the FR-008 gate
 * for this class.
 *
 * WHAT A SECOND IMPLEMENTATION ASSERTS: preservation only. Markdown conversion
 * lives in the editor bundle (chapter 12 §12.1), so a non-editor client's whole
 * obligation is to read a body, write it back unchanged, and match the digest —
 * no BlockNote block model, no markdown grammar, no parse-and-serialise round
 * trip on that side.
 *
 * Chapter: docs/protocol/12-note-body-format.md.
 */
import { createHash } from 'node:crypto'

import * as Y from 'yjs'
import { FUZZ_FAMILIES, ROUNDTRIP_CASES } from '@memry/editor-schema/conformance'

import { meta } from './shared'

const sha256 = (value: string): string => createHash('sha256').update(value, 'utf8').digest('hex')
const hex = (bytes: Uint8Array): string => Buffer.from(bytes).toString('hex')

/**
 * A Y.Doc with a PINNED client id.
 *
 * `new Y.Doc()` draws a random `clientID`, and that id is encoded into every
 * update, so an unpinned document makes this class non-reproducible and
 * therefore exempt from the `vectors:check` gate — exactly the carve-out the
 * gate exists to prevent. The value is arbitrary; only its fixedness matters.
 */
const VECTOR_CLIENT_ID = 0x6d656d72

function fixedDoc(): Y.Doc {
  const doc = new Y.Doc()
  doc.clientID = VECTOR_CLIENT_ID
  return doc
}

/** The four storage-layer cases the editor corpus has no reason to carry. */
const STORAGE_CASES = [
  {
    name: 'storage: a file with a BOM',
    markdown: '﻿---\ntitle: With a BOM\n---\n\nBody.\n',
    pins: 'splitFrontmatterBlock INCLUDES the BOM in the block, so block + body === raw stays byte-exact'
  },
  {
    name: 'storage: CRLF line endings throughout',
    markdown: '---\r\ntitle: CRLF\r\n---\r\n\r\nBody line one.\r\nBody line two.\r\n',
    pins: 'eol detection is "contains \\r\\n anywhere", and an edited body has its EOLs re-applied'
  },
  {
    name: 'storage: an unclosed --- block',
    markdown: '---\ntitle: never closed\n\nThis is all body.\n',
    pins: 'an unclosed block is NOT frontmatter; the whole file is body'
  },
  {
    name: 'storage: no trailing newline',
    markdown: '---\ntitle: No trailing newline\n---\n\nBody with no final newline.',
    pins: 'hadTrailingNewline is false, and an edited save must not invent one'
  }
]

/**
 * The five out-of-band encodings, each as a Y update carrying it.
 *
 * The failure these catch is a client that replays only `prosemirror` and
 * silently drops the other roots — which looks like a working client right up
 * until a desktop user loses their suggestion marks.
 */
function outOfBandCases(): unknown[] {
  const build = (
    name: string,
    pins: string,
    mutate: (doc: Y.Doc) => void,
    expectedRoots: string[]
  ): unknown => {
    const doc = fixedDoc()
    const fragment = doc.getXmlFragment('prosemirror')
    const paragraph = new Y.XmlElement('paragraph')
    paragraph.insert(0, [new Y.XmlText('Body the encoding rides alongside.')])
    fragment.insert(0, [paragraph])
    mutate(doc)
    return {
      name,
      pins,
      updateHex: hex(Y.encodeStateAsUpdate(doc)),
      expectedRoots,
      assertion:
        'apply the update to a fresh document, encode the FULL state back out, and every root here must survive'
    }
  }

  return [
    build(
      'out-of-band: inline colours',
      'MEMRYICO<n>: / :MEMRYICC; tokens mask a <span style=...> INSIDE the prosemirror fragment. An in-fragment encoding, not a sibling root',
      (doc) => {
        const fragment = doc.getXmlFragment('prosemirror')
        const paragraph = new Y.XmlElement('paragraph')
        paragraph.insert(0, [new Y.XmlText('MEMRYICO0:coloured:MEMRYICC;')])
        fragment.insert(fragment.length, [paragraph])
      },
      ['prosemirror']
    ),
    build(
      'out-of-band: block markers',
      'block markers are HTML comments inside the fragment, again in-fragment rather than a root',
      (doc) => {
        const fragment = doc.getXmlFragment('prosemirror')
        const paragraph = new Y.XmlElement('paragraph')
        paragraph.setAttribute('textAlignment', 'center')
        paragraph.insert(0, [new Y.XmlText('<!-- align:center -->')])
        fragment.insert(fragment.length, [paragraph])
      },
      ['prosemirror']
    ),
    build(
      'out-of-band: suggestion marks',
      'the criticMarkupMarks root. Dropping it deletes every suggestion from the file on the next write-back AND re-enables source restoration, so the body is additionally re-spelled',
      (doc) => {
        doc
          .getArray('criticMarkupMarks')
          .push([{ id: 'm1', kind: 'insertion', visibleText: 'added', start: 0, end: 5 }])
      },
      ['prosemirror', 'criticMarkupMarks']
    ),
    build(
      'out-of-band: link references',
      'both linkReference roots. Dropping them deletes the definitions and inlines [docs][d]',
      (doc) => {
        doc
          .getArray('linkReferenceDefinitions')
          .push([{ label: 'd', url: 'https://example.invalid' }])
        doc.getArray('linkReferenceUsages').push([{ label: 'd', text: 'docs' }])
      },
      ['prosemirror', 'linkReferenceDefinitions', 'linkReferenceUsages']
    ),
    build(
      'out-of-band: the preserved markdown source',
      'the markdownSource root. Dropping it re-spells foreign-vault bytes to house style on the next write-back: a git diff across the user files',
      (doc) => {
        doc
          .getMap('markdownSource')
          .set('record', { source: '# Foreign spelling\\n\\n*  odd bullet\\n' })
      },
      ['prosemirror', 'markdownSource']
    ),
    build(
      'out-of-band: a FOREIGN root no client knows',
      'THE CASE THAT PINS "including unnamed roots". A root this specification does not name must survive a decode and a full-state re-encode untouched (FR-033)',
      (doc) => {
        doc.getMap('someFutureRootNobodyKnows').set('k', 'v')
        doc.getArray('anotherOne').push([1, 2, 3])
      },
      ['prosemirror', 'someFutureRootNobodyKnows', 'anotherOne']
    )
  ]
}

export function buildMarkdownRoundtrip(): { cases: unknown; fuzzFamilies: unknown } {
  const exported = ROUNDTRIP_CASES.map((entry) => ({
    name: entry.name,
    markdown: entry.markdown,
    canonical: entry.canonical ?? null,
    pending: entry.pending ?? null,
    sha256: sha256(entry.markdown)
  }))

  const storage = STORAGE_CASES.map((entry) => ({
    name: entry.name,
    markdown: entry.markdown,
    canonical: null,
    pending: null,
    sha256: sha256(entry.markdown),
    pins: entry.pins
  }))

  const outOfBand = outOfBandCases()

  return {
    cases: {
      meta: meta({
        class: 'markdown-roundtrip',
        chapter: 'docs/protocol/12-note-body-format.md',
        source: 'packages/editor-schema/src/conformance.ts',
        exportedCaseCount: exported.length,
        storageCaseCount: storage.length,
        outOfBandCaseCount: outOfBand.length,
        caseCount: exported.length + storage.length + outOfBand.length,
        secondImplementationAsserts: 'byte preservation only; the editor bundle owns conversion'
      }),
      cases: exported,
      storageCases: storage,
      outOfBandCases: outOfBand
    },
    fuzzFamilies: {
      meta: meta({
        class: 'markdown-roundtrip-fuzz',
        source: 'packages/editor-schema/src/conformance.ts',
        seed: '0x1848',
        casesPerFamily: 48,
        familyCount: FUZZ_FAMILIES.length
      }),
      families: FUZZ_FAMILIES.map((family) => ({
        name: family.name,
        pending: family.pending ?? null
      }))
    }
  }
}
