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
      siteName: { default: '' },
      sourceText: { default: '' }
    },
    content: 'none'
  },
  {
    render: BookmarkBlockRender
  }
)

function escapeLinkText(text: string): string {
  return text.replace(/\s*\n\s*/g, ' ').replace(/([[\]])/g, '\\$1')
}

function urlHostname(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '')
  } catch {
    return url
  }
}

// Plain markdown link; sourceText re-emits the originally parsed line verbatim
// so foreign files stay byte-stable (docs/obs/03-bookmark-embed-plain-links.md).
export function serializeBookmark(props: {
  url: string
  title?: string
  sourceText?: string
}): string {
  if (props.sourceText) return props.sourceText
  return `[${escapeLinkText(props.title || urlHostname(props.url))}](${props.url})`
}
