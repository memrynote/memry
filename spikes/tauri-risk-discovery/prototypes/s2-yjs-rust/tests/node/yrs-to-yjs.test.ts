// S2 Test 3: yrs → Yjs. Load yrs-emitted v1 update, apply to Yjs Y.Doc, verify text.

import { describe, expect, test } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import * as Y from 'yjs'

const FIX_DIR = resolve(process.cwd(), 'tests/fixtures')

describe('S2 Test 3: yrs → Yjs roundtrip', () => {
  test('Yjs decodes yrs-emitted greeting update', () => {
    const bytes = readFileSync(resolve(FIX_DIR, 'yrs_greeting.bin'))
    const expected = readFileSync(resolve(FIX_DIR, 'yrs_greeting.expected.txt'), 'utf-8')

    const doc = new Y.Doc()
    Y.applyUpdate(doc, new Uint8Array(bytes))

    expect(doc.getText('t').toString()).toBe(expected)
  })
})
