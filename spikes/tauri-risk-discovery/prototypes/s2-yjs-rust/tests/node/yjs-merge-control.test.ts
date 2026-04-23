// S2 Test 4: Yjs ↔ Yjs merge (control). Two Y.Docs with concurrent edits
// exchange updates; final state must converge. Baseline for heterogeneous tests.

import { describe, expect, test } from 'vitest'
import * as Y from 'yjs'

describe('S2 Test 4: Yjs ↔ Yjs merge (control)', () => {
  test('two Y.Docs with concurrent edits converge to identical state', () => {
    const docA = new Y.Doc()
    docA.clientID = 1111
    const docB = new Y.Doc()
    docB.clientID = 2222

    docA.getText('t').insert(0, 'alpha_')
    docB.getText('t').insert(0, 'beta_')

    const updateA = Y.encodeStateAsUpdate(docA)
    const updateB = Y.encodeStateAsUpdate(docB)
    Y.applyUpdate(docA, updateB)
    Y.applyUpdate(docB, updateA)

    expect(docA.getText('t').toString()).toBe(docB.getText('t').toString())
    expect(docA.getText('t').toString()).toContain('alpha_')
    expect(docA.getText('t').toString()).toContain('beta_')
  })
})
