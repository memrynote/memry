/**
 * LinkMention inline content spec for BlockNote.
 *
 * The spec and its markdown token live in @memry/editor-schema so the main
 * process registers the identical node. See wiki-link.tsx for why.
 */

export {
  LinkMention,
  linkMentionConfig,
  MENTION_TOKEN_REGEX,
  serializeLinkMentionToken,
  parseLinkMentionToken,
  createLinkMentionContent
} from '@memry/editor-schema/inline'
