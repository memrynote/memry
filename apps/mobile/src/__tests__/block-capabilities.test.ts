// @vitest-environment jsdom

import { describe, expect, it } from 'vitest'

import { BlockNoteEditor } from '@blocknote/core'

import { createMobileEditorSchema } from '../../editor-web/src/schema'
import {
  blockCapabilities,
  carriesAttachment,
  LONG_PRESS_BLOCK_TYPES,
  type BlockCapabilities,
  type BlockLikeForCaps,
  type SchemaLikeForCaps
} from '../../editor-web/src/block-capabilities'

/**
 * Every hide rule in the block menu, against the schema the app actually runs (#2100).
 *
 * The table below is the propSchema of `createMobileEditorSchema()`, not a
 * hand-copy of desktop's menu: a colour prop appearing or disappearing in
 * `@memry/editor-schema` has to move this file, which is the only thing that
 * can keep the two menus from drifting apart silently.
 *
 * `mobile-editor-block-coverage.test.ts` is the list this one is measured
 * against — it fails when the schema grows a block key nobody classified, and
 * the last case here fails when that key never reaches this table.
 */

const schema = createMobileEditorSchema()

function editor() {
  return BlockNoteEditor.create({ schema: createMobileEditorSchema() })
}

/** The concession `StyleEditorSurface` already makes: a structural read of a generic schema. */
function schemaSurface(): SchemaLikeForCaps {
  return schema as unknown as SchemaLikeForCaps
}

/** One block of the given type, read back as the editor stores it. */
function block(spec: Record<string, unknown>): BlockLikeForCaps {
  const instance = editor()
  instance.replaceBlocks(instance.document, [spec as never])
  return instance.document[0] as unknown as BlockLikeForCaps
}

function caps(spec: Record<string, unknown>): BlockCapabilities {
  return blockCapabilities(block(spec), schemaSurface())
}

/**
 * The expected table, derived by hand FROM the propSchema so a mistake in
 * `blockCapabilities` cannot be papered over by deriving both sides the same
 * way. `colourText` / `colourBackground` here are exactly
 * `'textColor' in propSchema` / `'backgroundColor' in propSchema`.
 */
const EXPECTED: Readonly<
  Record<
    string,
    { spec: Record<string, unknown>; text: boolean; background: boolean; move: boolean }
  >
> = {
  paragraph: {
    spec: { type: 'paragraph', content: 'A' },
    text: true,
    background: true,
    move: true
  },
  heading: { spec: { type: 'heading', content: 'A' }, text: true, background: true, move: true },
  bulletListItem: {
    spec: { type: 'bulletListItem', content: 'A' },
    text: true,
    background: true,
    move: true
  },
  numberedListItem: {
    spec: { type: 'numberedListItem', content: 'A' },
    text: true,
    background: true,
    move: true
  },
  checkListItem: {
    spec: { type: 'checkListItem', content: 'A' },
    text: true,
    background: true,
    move: true
  },
  toggleListItem: {
    spec: { type: 'toggleListItem', content: 'A' },
    text: true,
    background: true,
    move: true
  },
  quote: { spec: { type: 'quote', content: 'A' }, text: true, background: true, move: true },
  // Text only: the callout's own tinted surface IS its background, so the
  // schema gives it no `backgroundColor` to overwrite.
  callout: { spec: { type: 'callout', content: 'A' }, text: true, background: false, move: true },
  // Text only as well, and unreachable by long-press: its cells are editable.
  table: {
    spec: {
      type: 'table',
      content: {
        type: 'tableContent',
        rows: [{ cells: [[{ type: 'text', text: 'A', styles: {} }]] }]
      }
    },
    text: true,
    background: false,
    move: true
  },
  codeBlock: { spec: { type: 'codeBlock' }, text: false, background: false, move: true },
  divider: { spec: { type: 'divider' }, text: false, background: false, move: true },
  // Background only, and never movable: the bytes live under the source note's id.
  image: {
    spec: { type: 'image', props: { url: 'a.png' } },
    text: false,
    background: true,
    move: false
  },
  video: {
    spec: { type: 'video', props: { url: 'a.mp4' } },
    text: false,
    background: true,
    move: false
  },
  audio: {
    spec: { type: 'audio', props: { url: 'a.m4a' } },
    text: false,
    background: true,
    move: false
  },
  file: {
    spec: { type: 'file', props: { url: 'a.pdf' } },
    text: false,
    background: false,
    move: false
  },
  bookmark: {
    spec: { type: 'bookmark', props: { url: 'https://memry.app' } },
    text: false,
    background: false,
    move: true
  },
  youtubeEmbed: {
    spec: { type: 'youtubeEmbed', props: { videoId: 'abc' } },
    text: false,
    background: false,
    move: true
  },
  taskBlock: {
    spec: { type: 'taskBlock', props: { taskId: 't1', title: 'A' } },
    text: false,
    background: false,
    move: true
  }
}

describe('block capabilities', () => {
  for (const [type, row] of Object.entries(EXPECTED)) {
    it(`derives ${type}'s colour rows from its own propSchema`, () => {
      const propSchema = schemaSurface().blockSchema[type].propSchema
      // The assertion is on the SCHEMA first, so a wrong expectation above is a
      // failure here rather than a `blockCapabilities` bug that agrees with it.
      expect({
        text: 'textColor' in propSchema,
        background: 'backgroundColor' in propSchema
      }).toEqual({ text: row.text, background: row.background })

      expect(caps(row.spec)).toMatchObject({
        colourText: row.text,
        colourBackground: row.background,
        canMove: row.move,
        hasChildren: false
      })
    })
  }

  it('covers every block type the schema can build', () => {
    // The coverage gate's list and this one are the same set, or a new block
    // ships with a menu nobody decided the rules for.
    expect(Object.keys(EXPECTED).sort()).toEqual(Object.keys(schema.blockSchema).sort())
  })

  it('names the block in words, with the heading level that tells two apart', () => {
    expect(caps({ type: 'paragraph', content: 'A' }).label).toBe('Paragraph')
    expect(caps({ type: 'heading', props: { level: 2 }, content: 'A' }).label).toBe('Heading 2')
    expect(caps({ type: 'heading', props: { level: 4 }, content: 'A' }).label).toBe('Heading 4')
    expect(caps({ type: 'bulletListItem', content: 'A' }).label).toBe('Bulleted list')
    expect(caps({ type: 'image', props: { url: 'a.png' } }).label).toBe('Image')
    // A block type this build has never heard of still gets a sheet title.
    expect(
      blockCapabilities({ type: 'someFutureBlock', props: {}, content: [] }, schemaSurface())
    ).toMatchObject({ label: 'Block', colourText: false, colourBackground: false })
  })

  it('reports the subtree the panel has to warn about', () => {
    const instance = editor()
    instance.replaceBlocks(instance.document, [
      {
        type: 'toggleListItem',
        content: 'Parent',
        children: [{ type: 'paragraph', content: 'Kid' }]
      }
    ])

    const parent = instance.document[0] as unknown as BlockLikeForCaps
    expect(blockCapabilities(parent, schemaSurface()).hasChildren).toBe(true)
    expect(
      blockCapabilities(parent.children![0] as BlockLikeForCaps, schemaSurface()).hasChildren
    ).toBe(false)
  })

  it('refuses to move a paragraph that carries an inline image', () => {
    // Desktop's rule, and the reason it is not a block-type set on its own: the
    // bytes are under the source note's id wherever the reference sits.
    const withInlineImage = block({
      type: 'paragraph',
      content: [
        { type: 'text', text: 'see ', styles: {} },
        { type: 'inlineImage', props: { src: 'attachments/n1/a.png' } }
      ]
    })

    expect(carriesAttachment(withInlineImage)).toBe(true)
    expect(blockCapabilities(withInlineImage, schemaSurface()).canMove).toBe(false)
    expect(carriesAttachment(block({ type: 'paragraph', content: 'plain' }))).toBe(false)
  })

  it('keeps long-press off every block whose text the loupe owns', () => {
    const textTypes = [
      'paragraph',
      'heading',
      'bulletListItem',
      'numberedListItem',
      'checkListItem',
      'toggleListItem',
      'quote',
      'codeBlock',
      'callout'
    ]
    for (const type of textTypes) expect(LONG_PRESS_BLOCK_TYPES.has(type)).toBe(false)
    // A table's CELLS are editable text, so it is reachable from `•••` only.
    expect(LONG_PRESS_BLOCK_TYPES.has('table')).toBe(false)

    expect([...LONG_PRESS_BLOCK_TYPES].sort()).toEqual([
      'audio',
      'bookmark',
      'divider',
      'file',
      'image',
      'taskBlock',
      'video',
      'youtubeEmbed'
    ])
    // Nothing in the set may be a type the schema cannot build.
    for (const type of LONG_PRESS_BLOCK_TYPES) {
      expect(Object.keys(schema.blockSchema)).toContain(type)
    }
  })
})
