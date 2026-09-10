// @vitest-environment jsdom

import { describe, expect, it } from 'vitest'
import * as Y from 'yjs'
import { BlockNoteEditor } from '@blocknote/core'
import { prosemirrorToYXmlFragment, yXmlFragmentToProsemirrorJSON } from 'y-prosemirror'

import { createMobileEditorSchema } from '../../../editor-web/src/schema'
import {
  cloneYSubtree,
  findBlockContainer,
  topBlockGroup,
  trailingEmptyParagraphIndex
} from '../clone-y-subtree'

/**
 * The clone is the one host-side write in #2100 that can DESTROY content, so it
 * is asserted against a document BlockNote itself authored rather than a
 * hand-built Y tree: a hand-built tree only proves the copier agrees with the
 * test author about the shape, which is exactly the assumption that is at risk.
 *
 * The equality is on `yXmlFragmentToProsemirrorJSON` — the same read
 * y-prosemirror does when the guest binds the doc — so a mark, a prop or an
 * inline atom that fails to survive shows up as a JSON diff and not as a note
 * that quietly lost its bold.
 */

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/

type PmNode = { type: string; attrs?: Record<string, unknown>; content?: PmNode[] }

/** The fixtures are written in the app's own block shapes; the generic that
 *  types `initialContent` against the schema adds nothing a test can act on. */
function editorWith(content: unknown[]) {
  const editor = BlockNoteEditor.create({
    schema: createMobileEditorSchema(),
    initialContent: content as Parameters<typeof BlockNoteEditor.create>[0] extends {
      initialContent?: infer T
    }
      ? T
      : never
  })
  const host = document.createElement('div')
  document.body.appendChild(host)
  editor.mount(host)
  return editor
}

/** A Y.Doc holding what the editor is showing, bound the way the guest binds. */
function docFrom(editor: ReturnType<typeof editorWith>): Y.Doc {
  const doc = new Y.Doc()
  prosemirrorToYXmlFragment(editor.prosemirrorState.doc, doc.getXmlFragment('prosemirror'))
  return doc
}

function json(doc: Y.Doc): PmNode {
  return yXmlFragmentToProsemirrorJSON(doc.getXmlFragment('prosemirror')) as PmNode
}

/** The top blockGroup's children, as ProseMirror JSON. */
function containers(doc: Y.Doc): PmNode[] {
  const group = json(doc).content?.[0]
  return group?.content ?? []
}

/** Every value the tree carries under an `id` attribute. */
function ids(node: PmNode): string[] {
  const own = typeof node.attrs?.id === 'string' && node.attrs.id.length > 0 ? [node.attrs.id] : []
  return [...own, ...(node.content ?? []).flatMap(ids)]
}

/** The same tree with every id blanked, so only the CONTENT is compared. */
function withoutIds(node: PmNode): PmNode {
  return {
    ...node,
    ...(node.attrs ? { attrs: { ...node.attrs, ...('id' in node.attrs ? { id: '' } : {}) } } : {}),
    ...(node.content ? { content: node.content.map(withoutIds) } : {})
  }
}

/**
 * One block of every kind the copier has to carry: a prop-bearing heading, a
 * paragraph whose runs carry marks AND two inline atoms, a list with nested
 * children, and a callout with a block-level colour prop.
 */
const FIXTURE = [
  { type: 'heading', props: { level: 2 }, content: 'Chapter' },
  {
    type: 'paragraph',
    content: [
      { type: 'text', text: 'plain ', styles: {} },
      { type: 'text', text: 'bold', styles: { bold: true } },
      { type: 'text', text: ' and ', styles: {} },
      {
        type: 'link',
        href: 'https://example.com',
        content: [{ type: 'text', text: 'a link', styles: { italic: true } }]
      },
      { type: 'text', text: ' ', styles: {} },
      { type: 'wikiLink', props: { target: 'Other note', alias: 'that one' } },
      { type: 'text', text: ' on ', styles: {} },
      {
        type: 'dateMention',
        props: { anchorId: 'anchor-1', dateISO: '2026-01-02', hasTime: false }
      }
    ]
  },
  {
    type: 'bulletListItem',
    content: 'parent',
    children: [
      { type: 'bulletListItem', content: 'child one' },
      {
        type: 'bulletListItem',
        content: 'child two',
        children: [{ type: 'paragraph', content: 'grandchild' }]
      }
    ]
  },
  { type: 'callout', props: { type: 'warning', textColor: 'orange' }, content: 'Mind the gap' },
  { type: 'paragraph', content: '' }
]

function source(): Y.Doc {
  return docFrom(editorWith(FIXTURE))
}

/** An EMPTY note's doc — one blank paragraph, which is what BlockNote makes. */
function empty(): Y.Doc {
  return docFrom(editorWith([{ type: 'paragraph', content: '' }]))
}

describe('cloneYSubtree', () => {
  it('carries every block across identically but for its ids', () => {
    const docA = source()
    const from = containers(docA)

    for (const block of from) {
      const blockId = block.attrs?.id
      expect(typeof blockId).toBe('string')

      const src = findBlockContainer(docA, blockId as string)
      expect(src).not.toBeNull()

      const docB = empty()
      const group = topBlockGroup(docB)
      expect(group).not.toBeNull()
      cloneYSubtree(src as Y.XmlElement)(group as Y.XmlElement)

      // Appended at the END: index 0 is the target's own blank paragraph.
      const landed = containers(docB)[1]
      expect(withoutIds(landed)).toEqual(withoutIds(block))
    }
  })

  it('mints a fresh v4 id on every container in the subtree', () => {
    const docA = source()
    const parent = containers(docA).find((block) => ids(block).length > 1)
    // The nested list: the whole point is that the CHILDREN are re-idded too.
    expect(parent).toBeDefined()
    const before = ids(parent as PmNode)
    expect(before.length).toBeGreaterThan(2)

    const docB = empty()
    cloneYSubtree(findBlockContainer(docA, before[0]) as Y.XmlElement)(
      topBlockGroup(docB) as Y.XmlElement
    )

    const after = ids(containers(docB)[1])
    expect(after).toHaveLength(before.length)
    for (const id of after) {
      expect(id).toMatch(UUID_V4)
      // Reuse would put one id in two notes for as long as the source delete
      // is outstanding — and a crash makes that "for ever".
      expect(before).not.toContain(id)
    }
    expect(new Set(after).size).toBe(after.length)
  })

  it('leaves the source document untouched', () => {
    const docA = source()
    const beforeJson = JSON.stringify(json(docA))

    const docB = empty()
    const first = containers(docA)[0].attrs?.id as string
    cloneYSubtree(findBlockContainer(docA, first) as Y.XmlElement)(
      topBlockGroup(docB) as Y.XmlElement
    )

    expect(JSON.stringify(json(docA))).toBe(beforeJson)
  })

  it('finds a block nested under another block', () => {
    const docA = source()
    const parent = containers(docA).find((block) => ids(block).length > 1) as PmNode
    const nestedId = ids(parent)[1]

    const found = findBlockContainer(docA, nestedId)
    expect(found?.getAttribute('id')).toBe(nestedId)
  })

  it('returns null for a block id the document does not hold', () => {
    expect(findBlockContainer(source(), 'not-a-block')).toBeNull()
  })

  it('refuses to publish a container that has been emptied under it', () => {
    // What a concurrent pull leaves behind: the container is still a live Y
    // type, its content is gone. Copying it would put a block BlockNote cannot
    // render into the target note, on every device.
    const docA = new Y.Doc()
    const group = new Y.XmlElement('blockGroup')
    const container = new Y.XmlElement('blockContainer')
    container.setAttribute('id', 'hollow')
    group.push([container])
    docA.getXmlFragment('prosemirror').push([group])

    const docB = empty()
    expect(() =>
      cloneYSubtree(findBlockContainer(docA, 'hollow') as Y.XmlElement)(
        topBlockGroup(docB) as Y.XmlElement
      )
    ).toThrow('no content to move')
    expect(containers(docB)).toHaveLength(1)
  })
})

describe('trailingEmptyParagraphIndex', () => {
  it('names the trailing blank paragraph', () => {
    const doc = source()
    const group = topBlockGroup(doc) as Y.XmlElement
    expect(trailingEmptyParagraphIndex(group)).toBe(group.length - 1)
  })

  it('is null when the note ends in content', () => {
    const doc = docFrom(editorWith([{ type: 'paragraph', content: 'last word' }]))
    expect(trailingEmptyParagraphIndex(topBlockGroup(doc) as Y.XmlElement)).toBeNull()
  })

  it('is null when the trailing paragraph holds an inline atom', () => {
    const doc = docFrom(
      editorWith([
        { type: 'paragraph', content: [{ type: 'wikiLink', props: { target: 'Other note' } }] }
      ])
    )
    expect(trailingEmptyParagraphIndex(topBlockGroup(doc) as Y.XmlElement)).toBeNull()
  })

  it('is null when the trailing blank paragraph has children of its own', () => {
    const doc = docFrom(
      editorWith([
        { type: 'paragraph', content: '', children: [{ type: 'paragraph', content: 'kid' }] }
      ])
    )
    expect(trailingEmptyParagraphIndex(topBlockGroup(doc) as Y.XmlElement)).toBeNull()
  })

  it('inserts the clone BEFORE the blank line rather than under it', () => {
    const docA = source()
    const heading = containers(docA)[0]
    const docB = empty()
    const group = topBlockGroup(docB) as Y.XmlElement
    const at = trailingEmptyParagraphIndex(group)
    expect(at).toBe(0)

    cloneYSubtree(findBlockContainer(docA, heading.attrs?.id as string) as Y.XmlElement)(
      group,
      at as number
    )

    const landed = containers(docB)
    expect(landed).toHaveLength(2)
    expect(withoutIds(landed[0])).toEqual(withoutIds(heading))
    // …and the caret line is still the caret line.
    expect(trailingEmptyParagraphIndex(group)).toBe(1)
  })
})
