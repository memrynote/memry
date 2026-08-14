import type { InlineContentSpec } from '@blocknote/core'
import { LinkMention } from './link-mention'
import { wikiLinkConfig } from './wiki-link'
import { hashTagConfig } from './hash-tag'
import { dateMentionConfig } from './date-mention'

export * from './wiki-link'
export * from './link-mention'
export * from './hash-tag'
export * from './date-mention'

/**
 * The specs each process supplies for itself. The config and the serialization
 * half still come from here (via `createHashTagSpec` / `createDateMentionSpec`,
 * or `WikiLink` / `WikiLinkSerializationOnly`), so only presentation and
 * HTML-paste behaviour differ. linkMention needs no entry — it is portable and
 * shared whole.
 */
export interface MemryInlineSpecs {
  hashTag: InlineContentSpec<typeof hashTagConfig>
  dateMention: InlineContentSpec<typeof dateMentionConfig>
  /**
   * `WikiLink` in the editor, `WikiLinkSerializationOnly` in main: the editor
   * spec's `parse` promotes any element whose whole text is `[[X]]`, which is
   * useful on paste and destructive in a markdown importer. Same node either
   * way — see wiki-link.ts.
   */
  wikiLink: InlineContentSpec<typeof wikiLinkConfig>
}

/**
 * Every custom inline node type Memry can put in a document, ready to spread
 * into `BlockNoteSchema.create`. Both processes build from this one list, so a
 * spec cannot exist on one side only.
 */
export function createMemryInlineContentSpecs(specs: MemryInlineSpecs) {
  return {
    wikiLink: specs.wikiLink,
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
