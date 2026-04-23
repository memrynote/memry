// S2 Yjs fixture generator.
//
// Writes binary Yjs update fixtures + expected-text sidecars into
// tests/fixtures/. Consumed by Rust cargo integration tests (decode via yrs)
// and by vitest Node tests (baseline comparisons).
//
// Run: pnpm tsx scripts/generate-yjs-fixtures.ts

import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import * as Y from 'yjs'

const __dirname = dirname(fileURLToPath(import.meta.url))
const FIX_DIR = resolve(__dirname, '../tests/fixtures')

mkdirSync(FIX_DIR, { recursive: true })

function write(name: string, bytes: Uint8Array, expected?: string): void {
  writeFileSync(resolve(FIX_DIR, `${name}.bin`), bytes)
  if (expected !== undefined) {
    writeFileSync(resolve(FIX_DIR, `${name}.expected.txt`), expected)
  }
  console.log(`[yjs-fix] ${name}.bin (${bytes.length} bytes)`)
}

// Fixture 1: simple text "hello world"
{
  const doc = new Y.Doc()
  doc.getText('t').insert(0, 'hello world')
  write('yjs_hello_world', Y.encodeStateAsUpdate(doc), 'hello world')
}

// Fixture 2: edit sequence (insert → delete → insert) exercises delete semantics
{
  const doc = new Y.Doc()
  const t = doc.getText('t')
  t.insert(0, 'abcde')
  t.delete(1, 2)
  t.insert(2, 'XYZ')
  write('yjs_edit_sequence', Y.encodeStateAsUpdate(doc), t.toString())
}

// Fixture 3: Yjs client with clientID=1111, text "alpha_" (for heterogeneous merge)
{
  const doc = new Y.Doc()
  doc.clientID = 1111
  doc.getText('t').insert(0, 'alpha_')
  write('yjs_concurrent_a', Y.encodeStateAsUpdate(doc), doc.getText('t').toString())
}

console.log('[yjs-fix] done')
