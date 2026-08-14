/**
 * `wikiLink` inline content spec.
 *
 * Lives here rather than in the renderer because the main process needs the
 * same node: a spec the main-process schema does not carry is not a rendering
 * gap, it is data loss — y-prosemirror deletes any element it cannot build,
 * straight out of the shared Y.Doc. Fully portable (vanilla DOM, no renderer
 * imports), so both processes use this spec unchanged.
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

export const wikiLinkConfig = {
  type: 'wikiLink' as const,
  propSchema: {
    target: { default: '' },
    alias: { default: '' }
  },
  content: 'none' as const
}

/** The markdown form: `[[target]]`, or `[[target|alias]]` when they differ. */
export function wikiLinkToText(target: string, alias: string): string {
  return alias && alias !== target ? `[[${target}|${alias}]]` : `[[${target}]]`
}

export const WikiLink = createInlineContentSpec(wikiLinkConfig, {
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
    const dom = document.createElement('span')
    dom.textContent = wikiLinkToText(
      inlineContent.props.target || '',
      inlineContent.props.alias || ''
    )
    return { dom }
  }
})
