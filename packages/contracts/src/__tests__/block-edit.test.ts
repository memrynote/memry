/**
 * Verifier for `block-edit.json` (N107).
 *
 * **What this half can and cannot prove.** There is no TypeScript writer —
 * node construction lives in Rust by design (plan §3 D1), so this verifier
 * cannot apply an operation. What it can prove is that the file is a valid
 * contract to hold Rust to: that the two canonical strings really are what
 * those two documents render to, that every operation names a block the base
 * actually contains, and that an operation's expected result differs from its
 * base at all. A case whose base and result were identical would pass in Rust
 * with the writer deleted.
 *
 * It reads the committed file and never imports the builder (README rule 2).
 */
import * as Y from 'yjs'
import { describe, expect, it } from 'vitest'

import { canonicalFragment } from '../../scripts/fragment-canonical'
import { extractBlocks } from '../../scripts/extract-blocks'
import { fromHex, loadVectorFile } from './vector-loader'

type Op =
  | { kind: 'setText'; blockId: string; text: string }
  | { kind: 'setProp'; blockId: string; name: string; value: string }
  | { kind: 'insertParagraph'; afterBlockId?: string; text: string; newBlockId: string }
  | { kind: 'delete'; blockId: string }

interface Case {
  name: string
  pins: string
  op: Op
  baseUpdateHex: string
  baseCanonical: string
  expectedUpdateHex: string
  expectedCanonical: string
  pending?: { reason: string; task: string }
}

const vectors = loadVectorFile<{
  meta: { caseCount: number; fragmentName: string; compares: string }
  cases: Case[]
}>('block-edit.json')

function applied(updateHex: string): Y.Doc {
  const doc = new Y.Doc()
  Y.applyUpdate(doc, fromHex(updateHex))
  return doc
}

/** Every block id in a document, including nested ones. */
function ids(updateHex: string): string[] {
  return extractBlocks(applied(updateHex))
    .map((block) => block.id)
    .filter((id): id is string => id !== null)
}

describe('block-edit vectors', () => {
  it('carries the recorded case count', () => {
    expect(vectors.cases).toHaveLength(vectors.meta.caseCount)
  })

  it('records that it compares documents rather than update bytes', () => {
    // The one fact a reader of this class must not get wrong. An update
    // encodes clientID and per-client clocks, so two ports performing the
    // same edit legitimately differ.
    expect(vectors.meta.compares).toContain('never update bytes')
    expect(vectors.meta.fragmentName).toBe('prosemirror')
  })

  for (const entry of vectors.cases) {
    describe(entry.name, () => {
      it('renders its base document as the file records', () => {
        expect(canonicalFragment(applied(entry.baseUpdateHex))).toBe(entry.baseCanonical)
      })

      it('renders its expected document as the file records', () => {
        // This is what makes the Rust side's comparison meaningful: the string
        // it is held to is really a document BlockNote authored, not prose.
        expect(canonicalFragment(applied(entry.expectedUpdateHex))).toBe(entry.expectedCanonical)
      })

      it('actually changes the document', () => {
        // A case whose result equalled its base would pass in Rust with the
        // whole writer deleted.
        expect(entry.expectedCanonical).not.toBe(entry.baseCanonical)
      })

      it('names a block the base contains', () => {
        const present = ids(entry.baseUpdateHex)
        const target =
          entry.op.kind === 'insertParagraph' ? entry.op.afterBlockId : entry.op.blockId
        if (target === undefined) return
        expect(present, `${entry.op.kind} names a block the base does not hold`).toContain(target)
      })
    })
  }

  it('every base document has exactly one top-level child, a blockGroup', () => {
    // §12.5.0. A base that broke this would make the writer's job undefined,
    // and the append case exists precisely because getting it wrong is the
    // most dangerous thing a writing client can do.
    for (const entry of vectors.cases) {
      const topLevel = entry.baseCanonical.split('\n').filter((line) => line.startsWith('0 '))
      expect(topLevel, `${entry.name} base top level`).toEqual(['0 element blockGroup'])
    }
  })

  it('every expected document has exactly one top-level child too', () => {
    for (const entry of vectors.cases) {
      const topLevel = entry.expectedCanonical.split('\n').filter((line) => line.startsWith('0 '))
      expect(topLevel, `${entry.name} expected top level`).toEqual(['0 element blockGroup'])
    }
  })

  it('an insert names a new block id the base does not already hold', () => {
    for (const entry of vectors.cases) {
      if (entry.op.kind !== 'insertParagraph') continue
      expect(ids(entry.baseUpdateHex)).not.toContain(entry.op.newBlockId)
      expect(ids(entry.expectedUpdateHex)).toContain(entry.op.newBlockId)
    }
  })

  it('a delete removes exactly the block it names', () => {
    for (const entry of vectors.cases) {
      if (entry.op.kind !== 'delete') continue
      const before = ids(entry.baseUpdateHex)
      const after = ids(entry.expectedUpdateHex)
      expect(before).toContain(entry.op.blockId)
      expect(after).not.toContain(entry.op.blockId)
    }
  })

  it('every pending case names the task that will fix it', () => {
    // A pending flag with no owner is a defect nobody is going to find again.
    const pending = vectors.cases.filter((entry) => entry.pending)
    expect(
      pending.length,
      'no pending cases left — drop this test with the last flag'
    ).toBeGreaterThan(0)
    for (const entry of pending) {
      expect(entry.pending?.task, `${entry.name} has no owning task`).toMatch(/^N\d/)
      expect(entry.pending?.reason.length ?? 0).toBeGreaterThan(40)
    }
  })
})
