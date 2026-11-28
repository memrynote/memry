/**
 * Turns `((mention:…))` text back into `linkMention` nodes, through the
 * traversal every inline token kind shares (`inline-token-promote.ts`).
 */

import type { Block } from '@blocknote/core'
import {
  promoteInlineTokens,
  splitTextWithTokens,
  type InlineTokenPromoter
} from './inline-token-promote'
import {
  MENTION_TOKEN_REGEX,
  parseLinkMentionToken,
  createLinkMentionContent
} from './link-mention'

function extractDomain(url: string): string {
  try {
    return new URL(url).hostname.replace('www.', '')
  } catch {
    return url
  }
}

const linkMentionPromoter: InlineTokenPromoter = {
  marker: '((mention:',
  pattern: MENTION_TOKEN_REGEX,
  toNode: ([, encoded]) => {
    const url = parseLinkMentionToken(encoded)
    return url ? createLinkMentionContent(url, extractDomain(url)) : null
  }
}

export function splitTextWithLinkMentions(
  text: string,
  styles?: Record<string, boolean | string>
): { segments: Array<string | Record<string, unknown>>; didChange: boolean } {
  return splitTextWithTokens(linkMentionPromoter, text, styles)
}

export function normalizeLinkMentions(blocks: Block[]): { blocks: Block[]; didChange: boolean } {
  return promoteInlineTokens(linkMentionPromoter, blocks)
}
