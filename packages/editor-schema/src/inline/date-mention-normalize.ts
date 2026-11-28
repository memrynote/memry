/**
 * Turns `((date:…))` text back into `dateMention` nodes, through the traversal
 * every inline token kind shares (`inline-token-promote.ts`). A token the
 * strict parse refuses is salvaged to a plain date (#1845); one with no usable
 * date stays text.
 */

import type { Block } from '@blocknote/core'
import {
  DATE_MENTION_TOKEN_REGEX,
  parseDateMentionToken,
  salvageDateMentionToken
} from '@memry/shared/date-mention'
import { promoteInlineTokens, type InlineTokenPromoter } from './inline-token-promote'
import { createDateMentionContent } from './date-mention'

const dateMentionPromoter: InlineTokenPromoter = {
  marker: '((date:',
  pattern: DATE_MENTION_TOKEN_REGEX,
  toNode: ([, encoded]) => {
    const data = parseDateMentionToken(encoded) ?? salvageDateMentionToken(encoded)
    return data ? createDateMentionContent(data) : null
  }
}

export function normalizeDateMentions(blocks: Block[]): { blocks: Block[]; didChange: boolean } {
  return promoteInlineTokens(dateMentionPromoter, blocks)
}
