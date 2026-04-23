// S2 Test 5 (Node side): heterogeneous merge verification.
//
// Core assertion: a state produced by yrs merging (Yjs concurrent_a + yrs beta_)
// must decode to text identical to Yjs-only merge of (concurrent_a + concurrent_b).
// If these diverge, yrs is not byte-compatible for merge semantics with Yjs.

import { describe, expect, test } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import * as Y from 'yjs'

const FIX_DIR = resolve(process.cwd(), 'tests/fixtures')

describe('S2 Test 5: heterogeneous merge', () => {
  test('yrs-side converged state decodes in Yjs', () => {
    const convergedBytes = readFileSync(resolve(FIX_DIR, 'yrs_heterogeneous_converged.bin'))
    const expected = readFileSync(
      resolve(FIX_DIR, 'yrs_heterogeneous_converged.expected.txt'),
      'utf-8'
    )

    const doc = new Y.Doc()
    Y.applyUpdate(doc, new Uint8Array(convergedBytes))

    const text = doc.getText('t').toString()
    expect(text).toBe(expected)
    expect(text).toContain('alpha_')
    expect(text).toContain('beta_')
  })

  test('Yjs-side merge of (yjs_a + yrs_b) matches yrs-side converged text', () => {
    const yjsA = readFileSync(resolve(FIX_DIR, 'yjs_concurrent_a.bin'))
    const yrsB = readFileSync(resolve(FIX_DIR, 'yrs_concurrent_b.bin'))
    const yrsConvergedText = readFileSync(
      resolve(FIX_DIR, 'yrs_heterogeneous_converged.expected.txt'),
      'utf-8'
    )

    const doc = new Y.Doc()
    Y.applyUpdate(doc, new Uint8Array(yjsA))
    Y.applyUpdate(doc, new Uint8Array(yrsB))

    expect(doc.getText('t').toString()).toBe(yrsConvergedText)
  })
})
