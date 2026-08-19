/**
 * Renderer↔main schema parity (#1433) — the half of the gate that has to see
 * both schemas at once.
 *
 * `pnpm ipc:check` gates the renderer↔main IPC contract. The document schema is
 * the same kind of cross-process contract with a worse failure mode: main reads
 * the shared Y.Doc through y-prosemirror, which answers a node name its schema
 * cannot build by DELETING the element — replicated data loss, not a missing
 * style. So the two schemas must expose the same node types with the same
 * configs, and this is the file that says so.
 *
 * ## Why it lives in the renderer suite
 *
 * `pnpm check:architecture` forbids main importing `apps/desktop/src/renderer/**`
 * (and the renderer importing `@main/*`), so neither process's own test tree can
 * hold a comparison of the two. It does not have to: main's half of the schema
 * is not in `src/main` at all — it is `@memry/editor-schema/server`, a workspace
 * package deliberately kept portable (vanilla DOM, no React, no renderer
 * imports) precisely so it can run under Node + jsdom in the main process. This
 * test imports the renderer's `editorSchema` and that package. Both are things
 * the renderer is already allowed to import, so the comparison crosses no
 * boundary — and the renderer project is the only one with React and jsdom,
 * which the renderer's own specs need.
 *
 * The main process's use of the package is gated separately, in
 * `src/main/sync/blocknote-converter.test.ts`, against the real `yDocToMarkdown`.
 */

import { describe, expect, it, vi } from 'vitest'
import { defaultBlockSpecs } from '@blocknote/core'
import { createMemrySchema, MEMRY_INLINE_CONTENT_TYPES } from '@memry/editor-schema'
import { MEMRY_BLOCK_TYPES } from '@memry/editor-schema/blocks'
import { createServerBlockSpecs, createServerInlineSpecs } from '@memry/editor-schema/server'

// The file block's PDF preview pulls pdf.js, which touches `DOMMatrix` at
// import time and jsdom has none. Nothing else is stubbed: the point of this
// file is to compare the REAL renderer schema, so `createReactBlockSpec` and
// every spec factory run for real.
vi.mock('react-pdf', () => ({
  Document: () => null,
  Page: () => null,
  pdfjs: { GlobalWorkerOptions: { workerSrc: '' } }
}))

import { editorSchema } from './editor-schema'

// The schema the main process builds, assembled here exactly as
// `blocknote-converter.ts` assembles it.
const serverSchema = createMemrySchema({
  blocks: createServerBlockSpecs(),
  inline: createServerInlineSpecs()
})

const sorted = (values: readonly string[]): string[] => [...values].sort()

type ConfigMap = Record<string, unknown>

describe('renderer and main register the same node types', () => {
  it('the inline content key sets are identical', () => {
    // #given / #when / #then a type the renderer can author and main cannot
    // build is deleted out of the shared doc on the first write-back.
    expect(sorted(Object.keys(editorSchema.inlineContentSchema))).toEqual(
      sorted(Object.keys(serverSchema.inlineContentSchema))
    )
  })

  it('the block key sets are identical', () => {
    expect(sorted(Object.keys(editorSchema.blockSchema))).toEqual(
      sorted(Object.keys(serverSchema.blockSchema))
    )
  })

  it('the style key sets are identical', () => {
    // Marks travel in the same Y.Doc and take the same y-prosemirror path.
    expect(sorted(Object.keys(editorSchema.styleSchema))).toEqual(
      sorted(Object.keys(serverSchema.styleSchema))
    )
  })

  it.each(MEMRY_INLINE_CONTENT_TYPES)('%s is registered on both sides', (type) => {
    // Derived from the exported list, so a spec added to the package without
    // being wired into one of the two schemas fails here.
    expect(Object.keys(editorSchema.inlineContentSchema)).toContain(type)
    expect(Object.keys(serverSchema.inlineContentSchema)).toContain(type)
  })

  it.each(MEMRY_BLOCK_TYPES)('%s is registered on both sides', (type) => {
    expect(Object.keys(editorSchema.blockSchema)).toContain(type)
    expect(Object.keys(serverSchema.blockSchema)).toContain(type)
  })
})

describe('renderer and main agree on every node config', () => {
  // A propSchema is the node's (de)serialization contract. If the two disagree,
  // `yXmlFragmentToBlocks` parses the props differently on each side and the
  // difference lands in the vault file. Compared for EVERY type, not just the
  // custom ones: a default block can drift too — respreading `defaultBlockSpecs`
  // over the factory's syntax-highlighting `codeBlock` put BlockNote's plain one
  // back, which shows up here as a `language` default of `text` vs `javascript`.
  it.each(sorted([...new Set([...Object.keys(defaultBlockSpecs), ...MEMRY_BLOCK_TYPES])]))(
    'block %s has the same config on both sides',
    (type) => {
      const renderer = editorSchema.blockSchema as ConfigMap
      const server = serverSchema.blockSchema as ConfigMap
      expect(renderer[type]).toEqual(server[type])
    }
  )

  it.each(sorted(Object.keys(serverSchema.inlineContentSchema)))(
    'inline %s has the same config on both sides',
    (type) => {
      const renderer = editorSchema.inlineContentSchema as ConfigMap
      const server = serverSchema.inlineContentSchema as ConfigMap
      expect(renderer[type]).toEqual(server[type])
    }
  )

  it('both sides keep the factory codeBlock, not BlockNote’s plain one', () => {
    // #given the shared factory installs `createCodeBlockSpec(codeBlockOptions)`
    // for syntax highlighting. Respreading `defaultBlockSpecs` AFTER calling the
    // factory silently undoes that — it type-checks, it renders, and the only
    // visible symptom is that code stops being highlighted.
    const plain = (defaultBlockSpecs.codeBlock as unknown as { config: unknown }).config

    // #when / #then
    expect(editorSchema.blockSchema.codeBlock).not.toEqual(plain)
    expect(serverSchema.blockSchema.codeBlock).not.toEqual(plain)
    expect(editorSchema.blockSchema.codeBlock).toEqual(serverSchema.blockSchema.codeBlock)
  })
})
