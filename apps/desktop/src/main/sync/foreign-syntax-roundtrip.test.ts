import { describe, expect, it } from 'vitest'
import * as Y from 'yjs'
import { CRDT_FRAGMENT_NAME } from '@memry/contracts/ipc-crdt'
import { FOREIGN_SYNTAX_FIXTURES } from '@memry/shared/foreign-syntax-fixtures'
import { markdownToYFragment, yDocToMarkdown } from './blocknote-converter'

// Main-pipeline twin of the renderer foreign-syntax matrix (docs/obs/06):
// markdown → Y.Doc → markdown must be byte-identical for every fixture. This
// is the CRDT writeback path, so a failure here mangles the vault file on the
// next sync even if the renderer pipeline is clean.
async function roundTrip(markdown: string): Promise<string> {
  const doc = new Y.Doc()
  const fragment = doc.getXmlFragment(CRDT_FRAGMENT_NAME)
  const ok = await markdownToYFragment(markdown, fragment)
  expect(ok).toBe(true)
  return (await yDocToMarkdown(doc)) ?? ''
}

// Known list normalization: BlockNote's canonical output rewrites `-` bullets
// to `*` and tight lists to loose (docs/obs/06 open question 1 — global list
// style, not per-syntax). These rows flip to plain `it` when that lands.
// tasks-emoji-linked-task passes here because normalizeTaskBlocks regenerates
// the `- [ ] … {task:id}` line with a `-` marker.
const KNOWN_LIST_MARKER_FAILURES = new Set(['block-id-on-bullet', 'tasks-emoji-plain-checkbox'])

describe('foreign syntax round-trip (main CRDT pipeline)', () => {
  for (const fixture of FOREIGN_SYNTAX_FIXTURES) {
    const test = KNOWN_LIST_MARKER_FAILURES.has(fixture.name) ? it.fails : it
    test(`round-trips ${fixture.name} verbatim`, async () => {
      const once = await roundTrip(fixture.markdown)
      expect(once).toBe(fixture.markdown)
      const twice = await roundTrip(once)
      expect(twice).toBe(once)
    })
  }
})
