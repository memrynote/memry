import { describe, expect, it } from 'vitest'
import { BlockNoteEditor } from '@blocknote/core'
import { createMemrySchema } from '../schema'
import { createServerBlockSpecs, createServerInlineSpecs } from '../server'
import { parseImageCrop, withImageCrop } from './image-crop'
import { parseInlineImageAlt } from '../inline/inline-image'

function createEditor() {
  const schema = createMemrySchema({
    blocks: createServerBlockSpecs(),
    inline: createServerInlineSpecs()
  })
  return BlockNoteEditor.create({ schema })
}

const IMAGE_URL = 'memry-file://local/v/attachments/n/photo.png'
const CROP = { x: 10, y: 5, w: 80, h: 60 }

describe('image crop', () => {
  it('round-trips a crop and a width through the vault file', async () => {
    const editor = createEditor()
    const name = withImageCrop('photo.png', CROP)
    const markdown = await editor.blocksToMarkdownLossy([
      { type: 'image', props: { url: IMAGE_URL, name, previewWidth: 320 } }
    ])

    expect(markdown.trim()).toBe(`![photo.png|crop=10,5,80,60|320](${IMAGE_URL})`)
    const [block] = await editor.tryParseMarkdownToBlocks(markdown)
    expect(block.props).toMatchObject({ name, previewWidth: 320 })
    expect(parseImageCrop((block.props as { name: string }).name)).toEqual({
      name: 'photo.png',
      crop: CROP
    })
  })

  it('keeps the width readable by a build that knows no crop', () => {
    // An older build parses only the numeric tail; the crop stays in the name.
    expect(parseInlineImageAlt('photo.png|crop=10,5,80,60|320')).toEqual({
      alt: 'photo.png|crop=10,5,80,60',
      width: 320
    })
  })

  it('replaces and removes a crop without touching the name', () => {
    const cropped = withImageCrop('photo.png', CROP)
    expect(withImageCrop(cropped, { x: 0, y: 0, w: 50, h: 50 })).toBe('photo.png|crop=0,0,50,50')
    expect(withImageCrop(cropped, null)).toBe('photo.png')
    expect(withImageCrop('photo.png', { x: 0, y: 0, w: 100, h: 100 })).toBe('photo.png')
  })

  it('leaves a suffix that is no real rectangle in the name', () => {
    expect(parseImageCrop('a.png|crop=0,0,0,0')).toEqual({ name: 'a.png|crop=0,0,0,0', crop: null })
  })
})
