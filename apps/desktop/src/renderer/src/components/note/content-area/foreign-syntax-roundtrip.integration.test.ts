import { describe, expect, it, vi } from 'vitest'
import {
  BlockNoteEditor,
  BlockNoteSchema,
  defaultBlockSpecs,
  createCodeBlockSpec
} from '@blocknote/core'
import { codeBlockOptions } from '@blocknote/code-block'
import { FOREIGN_SYNTAX_FIXTURES } from '@memry/shared/foreign-syntax-fixtures'
import { parseMarkdownPreservingBlanks, serializeBlocksPreservingBlanks } from './markdown-utils'

// The callout renderer pulls in i18n; the render function is never invoked in
// this headless round-trip, but the module-level hook import must not explode.
vi.mock('@memry/i18n/renderer', () => ({ useT: () => ({ t: (key: string) => key }) }))

const { createCalloutBlock } = await import('./callout-block')

// Real-pipeline matrix (docs/obs/06): every fixture must survive
// parse → serialize byte-identically (first-pass identity), which is stricter
// than the idempotence-only CriticMarkup round-trip test. The schema mirrors
// editor-schema.ts minus specs the round-trip never feeds to BlockNote
// (file/youtubeEmbed/bookmark/taskBlock serialize without touching the editor;
// file would drag react-pdf into jsdom).
const matrixSchema = BlockNoteSchema.create({
  blockSpecs: {
    ...defaultBlockSpecs,
    codeBlock: createCodeBlockSpec(codeBlockOptions),
    callout: createCalloutBlock()
  }
})

async function roundTrip(markdown: string): Promise<string> {
  const editor = BlockNoteEditor.create({ schema: matrixSchema })
  const blocks = await parseMarkdownPreservingBlanks(editor, markdown)
  return serializeBlocksPreservingBlanks(editor, blocks)
}

// Known list normalization: BlockNote's canonical output rewrites `-` bullets
// to `*` and tight lists to loose (docs/obs/06 open question 1 — global list
// style, not per-syntax). Linked-task lines additionally regenerate from props
// until spec 02 carries the raw line. These rows flip to plain `it` when that
// work lands.
const KNOWN_LIST_MARKER_FAILURES = new Set([
  'block-id-on-bullet',
  'tasks-emoji-plain-checkbox',
  'tasks-emoji-linked-task'
])

describe('foreign syntax round-trip (renderer pipeline)', () => {
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
