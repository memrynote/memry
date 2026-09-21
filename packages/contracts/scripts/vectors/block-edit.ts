/**
 * Class: the block writer (`block-edit.json`), the write direction (N107).
 *
 * A base document, one operation, and the document the operation must produce.
 *
 * **Why this class compares documents and not update bytes.** It has to hold
 * an update `yrs` produced against one `yjs` produced, and that is not a byte
 * comparison: an update encodes `clientID` and per-client clocks, and struct
 * ordering, origin ids and run-length packing are free choices an
 * implementation may make differently while still converging. Two different
 * updates that converge are *both correct*, so a byte comparison would fail on
 * correct ports and catch nothing extra. `research.md` records the argument.
 *
 * So each case carries `baseUpdateHex` and `expectedCanonical`: a port applies
 * the operation to the base and renders the result through the canonical
 * fragment form (`../fragment-canonical.ts`, and `crdt/canonical.rs` on the
 * other side), and the two strings must match.
 *
 * **Both documents are authored through BlockNote**, which makes the assertion
 * "the writer produces the document BlockNote would have produced". That is
 * what chapter 12 §12.5.0 actually demands: y-prosemirror answers a node its
 * schema cannot construct by DELETING the element, silently — the update
 * applies, the document encodes, `extract_text` may still return the text, and
 * the next desktop to open the note renders it without the block. A writer
 * held only to its own idea of the shape cannot catch that.
 *
 * `expectedUpdateHex` is recorded too, so the TypeScript verifier can prove
 * the file's two canonical strings are really what those documents render to
 * without needing a TypeScript writer — there is none, because the writer
 * lives in Rust by design (plan §3 D1).
 *
 * Chapter: docs/protocol/12-note-body-format.md §12.5.0, §12.5.1.
 */
import * as Y from 'yjs'
import { BLOCK_EDIT_CASES } from '@memry/editor-schema/conformance'
import { blocksToDoc } from '@memry/editor-schema/conformance-ydoc'

import { canonicalFragment } from '../fragment-canonical'
import { meta } from './shared'

const hex = (bytes: Uint8Array): string => Buffer.from(bytes).toString('hex')

export function buildBlockEdit(): Record<string, unknown> {
  const cases = BLOCK_EDIT_CASES.map((entry) => {
    const base = blocksToDoc(entry.base, 'base')
    const expected = blocksToDoc(entry.expected, 'expected')
    return {
      name: entry.name,
      pins: entry.pins,
      op: entry.op,
      baseUpdateHex: hex(Y.encodeStateAsUpdate(base)),
      baseCanonical: canonicalFragment(base),
      expectedUpdateHex: hex(Y.encodeStateAsUpdate(expected)),
      expectedCanonical: canonicalFragment(expected),
      ...(entry.pending ? { pending: entry.pending } : {})
    }
  })

  return {
    meta: meta({
      class: 'block-edit',
      chapter: 'docs/protocol/12-note-body-format.md §12.5.0, §12.5.1',
      canonical: 'packages/contracts/scripts/fragment-canonical.ts',
      fragmentName: 'prosemirror',
      authoredBy: '@blocknote/server-util blocksToYXmlFragment, the path desktop main calls',
      compares:
        'the RESULTING DOCUMENT through the canonical fragment form, never update bytes: an update encodes clientID and per-client clocks, so two ports performing the same edit legitimately differ',
      notClaimed:
        'this does not pin the update a writer emits, only the document it must leave behind',
      caseCount: cases.length
    }),
    cases
  }
}
