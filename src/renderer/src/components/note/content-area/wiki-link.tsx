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

function getInlineContentText(content: Array<{ text?: string }> | undefined): string {
  if (!content || content.length === 0) return ''
  return content.map((item) => item.text ?? '').join('')
}

export function createWikiLinkInlineContent(
  target: string,
  alias: string,
  styles: Record<string, boolean | string> = {}
) {
  const displayText = alias?.trim() || target
  return {
    type: 'wikiLink',
    props: { target, alias: alias ?? '' },
    content: [{ type: 'text', text: displayText, styles }]
  }
}

export const WikiLink = createInlineContentSpec(
  {
    type: 'wikiLink',
    propSchema: {
      target: { default: '' },
      alias: { default: '' }
    },
    content: 'styled'
  },
  {
    render: (inlineContent) => {
      const dom = document.createElement('span')
      dom.className = 'wiki-link'
      dom.setAttribute('data-wiki-link', '')
      dom.setAttribute('title', inlineContent.props.target || '')

      const contentDOM = document.createElement('span')
      contentDOM.className = 'wiki-link-text'
      dom.appendChild(contentDOM)

      return { dom, contentDOM }
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
      const contentText = getInlineContentText(inlineContent.content as Array<{ text?: string }> | undefined)
      const displayText = contentText || inlineContent.props.alias || target
      const text =
        displayText && displayText !== target
          ? `[[${target}|${displayText}]]`
          : `[[${target}]]`

      const dom = document.createElement('span')
      dom.textContent = text
      return { dom }
    }
  }
)
