/**
 * WikiLink inline content spec for BlockNote.
 */

import { createInlineContentSpec } from '@blocknote/core'

const WIKI_LINK_FULL_PATTERN = /^\[\[([^\]|]+)(?:\|([^\]]+))?\]\]$/

export interface WikiLinkParts {
  target: string
  alias: string
}

export function parseWikiLinkText(text: string): WikiLinkParts | null {
  const match = text.trim().match(WIKI_LINK_FULL_PATTERN)
  if (!match) return null

  const target = match[1]?.trim()
  const alias = match[2]?.trim() ?? ''

  if (!target) return null
  return { target, alias }
}

export function createWikiLinkInlineContent(target: string, alias: string) {
  return {
    type: 'wikiLink',
    props: { target, alias: alias ?? '' }
  }
}

export const WikiLink = createInlineContentSpec(
  {
    type: 'wikiLink',
    propSchema: {
      target: { default: '' },
      alias: { default: '' }
    },
    content: 'none'
  },
  {
    render: (inlineContent) => {
      const dom = document.createElement('span')
      dom.className = 'wiki-link'
      dom.setAttribute('data-wiki-link', '')
      dom.setAttribute('data-target', inlineContent.props.target || '')
      dom.setAttribute('data-alias', inlineContent.props.alias || '')
      dom.setAttribute('title', inlineContent.props.target || '')
      dom.setAttribute('contenteditable', 'false')
      dom.textContent = inlineContent.props.alias || inlineContent.props.target || ''

      return { dom }
    },
    parse: (element) => {
      if (element.hasAttribute('data-wiki-link') || element.hasAttribute('data-target')) {
        const target = element.getAttribute('data-target')?.trim() || ''
        const alias = element.getAttribute('data-alias')?.trim() || ''
        if (target) {
          return { target, alias }
        }
      }

      const parsed = parseWikiLinkText(element.textContent ?? '')
      if (!parsed) return undefined
      return { target: parsed.target, alias: parsed.alias }
    },
    toExternalHTML: (inlineContent) => {
      const target = inlineContent.props.target || ''
      const alias = inlineContent.props.alias || ''
      const text = alias && alias !== target ? `[[${target}|${alias}]]` : `[[${target}]]`

      const dom = document.createElement('span')
      dom.textContent = text
      return { dom }
    }
  }
)
