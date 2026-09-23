/**
 * Class: the block walk (`note-blocks.json`), the read direction (N102/N103).
 *
 * Document bytes in, the block list a shell renders out.
 *
 * **Why this class exists.** `extract_blocks` had no vector class at all. The
 * only test holding it was `crates/memry-core/tests/crdt_blocks.rs`, which
 * asserts that the block walk and the text walk agree **with each other** —
 * and two walks of one port agree whether or not either is right. Dropping
 * `divider` passed that test for exactly that reason, and so did losing every
 * inline colour value. SC-010's digest does not help either: chapter 12 §12.11
 * defines it over `title + "\n" + extract_text(doc)`, so a shell can lose
 * every colour, every link target and every table boundary and still match.
 *
 * So this file is the measurement. It carries a case for each of the 18
 * blocks, 8 inline types and 7 styles of `registry-manifest.json`, and the
 * verifier asserts that coverage against the manifest rather than trusting the
 * list — a type nobody wrote a case for is a failing test, which is what makes
 * "a new block type is not done until it has a case" enforceable.
 *
 * **The bytes come from BlockNote**, through `blocksToYXmlFragment` in
 * `@memry/editor-schema/conformance-ydoc`, which is the production path
 * desktop's main process calls. Hand-built `Y.XmlElement` trees would pin what
 * someone believed y-prosemirror writes.
 *
 * **The canonical fragment rendering travels with each case**, because the
 * write class (`block-edit.json`) compares documents through that form and a
 * reader needs somewhere to see it proven against a document it can also read
 * as blocks.
 *
 * Chapter: docs/protocol/12-note-body-format.md §12.5.0, §12.9.
 */
import * as Y from 'yjs'
import { NOTE_BLOCK_CASES } from '@memry/editor-schema/conformance'
import { noteBlockDoc } from '@memry/editor-schema/conformance-ydoc'
import registryManifest from '@memry/editor-schema/registry-manifest.json' with { type: 'json' }

import { canonicalFragment } from '../fragment-canonical'
import { extractBlocks } from '../extract-blocks'
import { meta } from './shared'

const hex = (bytes: Uint8Array): string => Buffer.from(bytes).toString('hex')

export function buildNoteBlocks(): Record<string, unknown> {
  const cases = NOTE_BLOCK_CASES.map((entry) => {
    const doc = noteBlockDoc(entry)
    return {
      name: entry.name,
      pins: entry.pins,
      updateHex: hex(Y.encodeStateAsUpdate(doc)),
      expectedBlocks: extractBlocks(doc),
      expectedCanonical: canonicalFragment(doc)
    }
  })

  return {
    meta: meta({
      class: 'note-blocks',
      chapter: 'docs/protocol/12-note-body-format.md §12.5.0, §12.9',
      extractor: 'packages/contracts/scripts/extract-blocks.ts',
      canonical: 'packages/contracts/scripts/fragment-canonical.ts',
      fragmentName: 'prosemirror',
      authoredBy: '@blocknote/server-util blocksToYXmlFragment, the path desktop main calls',
      registry: {
        blocks: registryManifest.blocks.length,
        inline: registryManifest.inline.length,
        styles: registryManifest.styles.length
      },
      notClaimed:
        'this is not markdown and not a rendering; it is the block list a shell draws from',
      caseCount: cases.length
    }),
    cases
  }
}
