import type { InlineContentSpec } from '@blocknote/core'
import { WikiLink } from './wiki-link'
import { LinkMention } from './link-mention'
import { hashTagConfig } from './hash-tag'
import { dateMentionConfig } from './date-mention'

export * from './wiki-link'
export * from './link-mention'
export * from './hash-tag'
export * from './date-mention'

/**
 * The two specs whose presentation each process supplies for itself, built via
 * `createHashTagSpec` / `createDateMentionSpec` so the config and the
 * serialization half still come from here. wikiLink and linkMention need no
 * entry — they are portable and shared whole.
 */
export interface MemryInlineSpecs {
  hashTag: InlineContentSpec<typeof hashTagConfig>
  dateMention: InlineContentSpec<typeof dateMentionConfig>
}

/**
 * Every custom inline node type Memry can put in a document, ready to spread
 * into `BlockNoteSchema.create`. Both processes build from this one list, so a
 * spec cannot exist on one side only.
 */
export function createMemryInlineContentSpecs(specs: MemryInlineSpecs) {
  return {
    wikiLink: WikiLink,
    linkMention: LinkMention,
    hashTag: specs.hashTag,
    dateMention: specs.dateMention
  }
}

/** Node names of every custom inline spec — the parity gate reads this. */
export const MEMRY_INLINE_CONTENT_TYPES = [
  'wikiLink',
  'linkMention',
  'hashTag',
  'dateMention'
] as const
