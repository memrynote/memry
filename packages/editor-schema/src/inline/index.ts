import type { InlineContentSpec } from '@blocknote/core'
import { assertSpecKeysMatchNodeTypes } from '../spec-keys'
import { linkMentionConfig } from './link-mention'
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
 * HTML-paste behaviour differ.
 *
 * Every one of the four is listed. None can be "shared whole": BlockNote
 * serializes inline content inside a TABLE through `render`, so the editor's
 * rich implementation reaching the main process rewrites that cell's markdown.
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
  /**
   * `LinkMention` in the editor, `LinkMentionSerializationOnly` in main. The
   * editor chip renders an `<a>`; in a table cell that `<a>` is what gets
   * serialized, turning the `((mention:…))` token into a plain markdown link
   * and dropping domain/title/favicon/siteName from disk.
   */
  linkMention: InlineContentSpec<typeof linkMentionConfig>
}

/**
 * Every custom inline node type Memry can put in a document, ready to spread
 * into `BlockNoteSchema.create`. Both processes build from this one list, so a
 * spec cannot exist on one side only.
 *
 * The keys below are the node names BlockNote will key its `inlineContentSchema`
 * by; each spec's `config.type` is the node name ProseMirror will build. They
 * are asserted equal here rather than assumed — see spec-keys.ts (#1455).
 */
export function createMemryInlineContentSpecs(specs: MemryInlineSpecs) {
  const registered = {
    wikiLink: specs.wikiLink,
    linkMention: specs.linkMention,
    hashTag: specs.hashTag,
    dateMention: specs.dateMention
  }
  assertSpecKeysMatchNodeTypes('inlineContentSpecs', registered)
  return registered
}

/** Node names of every custom inline spec — the parity gate reads this. */
export const MEMRY_INLINE_CONTENT_TYPES = [
  'wikiLink',
  'linkMention',
  'hashTag',
  'dateMention'
] as const
