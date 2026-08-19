/**
 * `hashTag` inline content spec — serialization half only.
 *
 * Unlike wikiLink/linkMention, this one's `render` is not portable: it reaches
 * for the renderer's tag palette and HugeIcon loader. So the package owns the
 * part that decides what reaches the vault file (config + parse +
 * toExternalHTML) and each process supplies its own presentation. Main needs
 * the config registered or y-prosemirror deletes the node from the shared doc.
 */

import { createInlineContentSpec, type InlineContentSpec } from '@blocknote/core'
import type { CustomInlineContentImplementation } from '@blocknote/core'

export const hashTagConfig = {
  type: 'hashTag' as const,
  propSchema: {
    tag: { default: '' },
    color: { default: '' },
    icon: { default: '' }
  },
  content: 'none' as const
}

type HashTagRender = CustomInlineContentImplementation<typeof hashTagConfig, never>['render']

/** Everything that decides the node's on-disk form. Shared by both processes. */
export const hashTagSerialization = {
  parse: (element: HTMLElement) => {
    if (element.hasAttribute('data-hash-tag')) {
      const tag = element.getAttribute('data-hash-tag')?.trim() || ''
      if (tag) {
        const color = element.getAttribute('data-hash-tag-color')?.trim() || ''
        const icon = element.getAttribute('data-hash-tag-icon')?.trim() || ''
        return { tag, color, icon }
      }
    }
    return undefined
  },
  toExternalHTML: (inlineContent: { props: { tag: string } }) => {
    const dom = document.createElement('span')
    dom.textContent = `#${inlineContent.props.tag || ''}`
    return { dom }
  }
}

export function createHashTagSpec(render: HashTagRender): InlineContentSpec<typeof hashTagConfig> {
  return createInlineContentSpec(hashTagConfig, {
    render,
    ...hashTagSerialization
  })
}
