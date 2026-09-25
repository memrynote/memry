import { describe, expect, it } from 'vitest'
import { BlockNoteEditor } from '@blocknote/core'
import { createMemrySchema } from '../schema'
import { createServerBlockSpecs, createServerInlineSpecs } from '../server'
import { DEFAULT_IMAGE_PREVIEW_WIDTH, serializeImageBlockAlt } from './image-width'

/**
 * The shared schema's image under jsdom, the DOM the renderer and the mobile
 * WebView serialize with. The main process's bytes are gated separately, through
 * the real converter, in blocknote-converter.test.ts.
 */
function createEditor() {
  const schema = createMemrySchema({
    blocks: createServerBlockSpecs(),
    inline: createServerInlineSpecs()
  })
  return BlockNoteEditor.create({ schema })
}

const IMAGE_URL = 'memry-file://local/v/attachments/n/diagram.png'

describe('image block width in markdown', () => {
  it('writes a chosen width into the alt text and reads it back', async () => {
    const editor = createEditor()
    const markdown = await editor.blocksToMarkdownLossy([
      { type: 'image', props: { url: IMAGE_URL, name: 'diagram.png', previewWidth: 320 } }
    ])

    expect(markdown.trim()).toBe(`![diagram.png|320](${IMAGE_URL})`)
    const [block] = await editor.tryParseMarkdownToBlocks(markdown)
    expect(block.props).toMatchObject({ name: 'diagram.png', previewWidth: 320 })
  })

  it('writes no width for the insert default or an unsized image', () => {
    expect(serializeImageBlockAlt('a.png', DEFAULT_IMAGE_PREVIEW_WIDTH)).toBe('a.png')
    expect(serializeImageBlockAlt('a.png', undefined)).toBe('a.png')
    // A synced Y.Doc can hand the prop over as a string.
    expect(serializeImageBlockAlt('a.png', '320')).toBe('a.png|320')
  })

  it('lets a real width attribute outrank the alt suffix', async () => {
    const editor = createEditor()
    const [block] = await editor.tryParseHTMLToBlocks(
      `<img src="${IMAGE_URL}" alt="shot|300" width="200">`
    )

    expect(block.props).toMatchObject({ name: 'shot', previewWidth: 200 })
  })
})
