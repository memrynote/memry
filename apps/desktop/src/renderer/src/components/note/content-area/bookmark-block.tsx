import { createReactBlockSpec } from '@blocknote/react'
import { BookmarkBlockRender } from './bookmark-block-render'

export const createBookmarkBlock = createReactBlockSpec(
  {
    type: 'bookmark' as const,
    propSchema: {
      url: { default: '' },
      domain: { default: '' },
      title: { default: '' },
      description: { default: '' },
      image: { default: '' },
      favicon: { default: '' },
      siteName: { default: '' }
    },
    content: 'none'
  },
  {
    render: BookmarkBlockRender
  }
)

export const BOOKMARK_BLOCK_REGEX = /!\[bookmark\]\(([^)]+)\)/g

export function serializeBookmark(url: string): string {
  return `![bookmark](${url})`
}
