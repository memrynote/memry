import { describe, expect, it } from 'vitest'
import { normalizeYoutubeImages } from './youtube-images'

const image = (props: Record<string, unknown>, children: unknown[] = []) => ({
  id: 'img-1',
  type: 'image',
  props,
  children
})

describe('normalizeYoutubeImages', () => {
  it('turns an image an older build parsed from a YouTube line into an embed that keeps its alt', () => {
    // #given the block an older build stored for `![Embedded YouTube video](…)`
    const blocks = [
      image({
        url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
        name: 'Embedded YouTube video',
        caption: ''
      })
    ]

    // #when
    const result = normalizeYoutubeImages(blocks)

    // #then it plays, keeps its id so it is replaced in place, and writes the same line
    expect(result.didChange).toBe(true)
    expect(result.blocks[0]).toMatchObject({
      id: 'img-1',
      type: 'youtubeEmbed',
      props: {
        videoId: 'dQw4w9WgXcQ',
        videoUrl: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
        alt: 'Embedded YouTube video'
      }
    })
  })

  it.each([
    ['a real image', image({ url: 'https://example.com/a.png', name: 'a' })],
    // A caption is a second line on disk; the embed could not write it back.
    ['a captioned image', image({ url: 'https://youtu.be/dQw4w9WgXcQ', name: '', caption: 'c' })],
    [
      'an image with children',
      image({ url: 'https://youtu.be/dQw4w9WgXcQ' }, [image({ url: 'x' })])
    ],
    // `![bookmark](…)` is a bookmark card's marker, never an embed.
    ['an image named bookmark', image({ url: 'https://youtu.be/dQw4w9WgXcQ', name: 'bookmark' })]
  ])('leaves %s alone', (_label, block) => {
    expect(normalizeYoutubeImages([block])).toEqual({ blocks: [block], didChange: false })
  })
})
