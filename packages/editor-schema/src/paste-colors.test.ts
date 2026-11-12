import { describe, expect, it } from 'vitest'
import { BlockNoteEditor, COLORS_DEFAULT } from '@blocknote/core'
import { sidecarMarkerLines } from '@memry/shared/block-markers'
import { createMemrySchema, NAMED_BLOCK_COLORS } from './schema'
import { createServerBlockSpecs, createServerInlineSpecs } from './server'

function createEditor() {
  const schema = createMemrySchema({
    blocks: createServerBlockSpecs(),
    inline: createServerInlineSpecs()
  })
  return BlockNoteEditor.create({ schema })
}

// What WKWebView / WebKitGTK hand the page for `<h2>…</h2><p>…</p><ul>…</ul>`
// copied from another app: every element carries its computed styles inline.
const WEBKIT_STYLE =
  'caret-color: rgb(0, 0, 0); color: rgb(0, 0, 0); font-style: normal; letter-spacing: normal; text-align: start; text-indent: 0px; text-transform: none; white-space: normal; word-spacing: 0px; -webkit-text-stroke-width: 0px; text-decoration: none; background-color: rgba(0, 0, 0, 0)'
const WEBKIT_PASTE =
  `<meta charset="UTF-8"><h2 style="${WEBKIT_STYLE}">Rich heading</h2>` +
  `<p style="${WEBKIT_STYLE}">Plain and <strong>strong</strong></p>` +
  `<ul style="${WEBKIT_STYLE}"><li style="${WEBKIT_STYLE}">one item</li></ul>`

describe('pasted block colors (#4330)', () => {
  it('drops inline colors that are not a named editor color', () => {
    const blocks = createEditor().tryParseHTMLToBlocks(WEBKIT_PASTE)

    expect(blocks.map((b) => b.type)).toEqual(['heading', 'paragraph', 'bulletListItem'])
    for (const block of blocks) {
      expect(block.props).toMatchObject({ textColor: 'default', backgroundColor: 'default' })
      expect(sidecarMarkerLines(block)).toEqual([])
    }
  })

  it('drops hex and keyword colors too', () => {
    const [block] = createEditor().tryParseHTMLToBlocks(
      '<p style="color: #123456; background-color: inherit">x</p>'
    )
    expect(block.props).toMatchObject({ textColor: 'default', backgroundColor: 'default' })
  })

  it('keeps a named color from inline style and writes it to the file', () => {
    const [block] = createEditor().tryParseHTMLToBlocks(
      '<p style="color: red; background-color: blue">x</p>'
    )
    expect(block.props).toMatchObject({ textColor: 'red', backgroundColor: 'blue' })
    expect(sidecarMarkerLines(block)).toEqual([
      '<!-- colors:{"textColor":"red","backgroundColor":"blue"} -->'
    ])
  })

  it('round-trips a named color through the editor clipboard HTML', () => {
    const editor = createEditor()
    const html = editor.blocksToFullHTML([
      {
        type: 'heading',
        props: { level: 2, textColor: 'purple', backgroundColor: 'yellow' },
        content: 'h'
      }
    ])
    const [block] = editor.tryParseHTMLToBlocks(html)
    expect(block.props).toMatchObject({ textColor: 'purple', backgroundColor: 'yellow' })
  })

  it('keeps exactly the nine editor colors and default', () => {
    // Written out so a BlockNote upgrade that adds or renames a color fails here, and the
    // Rust list (rules/blocks.rs NAMED_BLOCK_COLORS) is pinned by `block-style-color-every-name`.
    expect(Object.keys(COLORS_DEFAULT).toSorted()).toEqual(
      ['gray', 'brown', 'red', 'orange', 'yellow', 'green', 'blue', 'purple', 'pink'].toSorted()
    )
    expect([...NAMED_BLOCK_COLORS].toSorted()).toEqual(
      [
        'default',
        'gray',
        'brown',
        'red',
        'orange',
        'yellow',
        'green',
        'blue',
        'purple',
        'pink'
      ].toSorted()
    )
  })
})
