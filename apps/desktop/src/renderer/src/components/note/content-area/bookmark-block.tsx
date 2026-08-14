import { createReactBlockSpec } from '@blocknote/react'
import { bookmarkConfig } from '@memry/editor-schema/blocks'
import { BookmarkBlockRender } from './bookmark-block-render'

// Type/props/content and the `![bookmark](url)` on-disk form come from the
// shared package so the main process registers the same node and writes the
// same bytes.
export const createBookmarkBlock = createReactBlockSpec(bookmarkConfig, {
  render: BookmarkBlockRender
})

export { BOOKMARK_BLOCK_REGEX, serializeBookmark } from '@memry/editor-schema/blocks'
