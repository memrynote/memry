import { createMemrySchema, WikiLink } from '@memry/editor-schema'
import { codeBlockOptions } from '@blocknote/code-block'
import { createFileBlock } from './file-block'
import { createCalloutBlock } from './callout-block'
import { createYoutubeEmbedBlock } from './youtube-embed-block'
import { createBookmarkBlock } from './bookmark-block'
import { createTaskBlock } from './task-block'
import { createToggleListItemBlock } from './toggle-list-item-block'
import { HashTag } from './hash-tag'
import { LinkMention } from './link-mention'
import { DateMention } from './date-mention'
import { InlineImage } from './inline-image'
import { InlineCheckbox } from './inline-checkbox'

// Built through the shared factory so the main process gets a schema with the
// same node types. Main converts the shared Y.Doc through y-prosemirror, which
// DELETES any element its schema cannot build — a spec registered on one side
// only replicates as data loss, not as a missing style. The inline specs come
// from the factory; only the two whose presentation needs renderer state
// (tag palette, clock/week-start settings) are passed in.
export const editorSchema = createMemrySchema({
  // Shiki, explicitly. The factory no longer imports it, so the bytes are a
  // per-surface choice; mobile's WebView cannot afford them (#2032).
  codeBlock: codeBlockOptions,
  // No `...defaultBlockSpecs` here: the factory already spreads them, and
  // respreading them after it would put BlockNote's plain `codeBlock` back over
  // the syntax-highlighting one the factory installs. Pass overrides only.
  blocks: {
    file: createFileBlock(),
    callout: createCalloutBlock(),
    youtubeEmbed: createYoutubeEmbedBlock(),
    bookmark: createBookmarkBlock(),
    taskBlock: createTaskBlock(),
    // A default block overridden, not a new one: BlockNote's own toggle keeps
    // its fold in localStorage, which is per-device and keyed by an id that is
    // regenerated on every parse (#1847).
    toggleListItem: createToggleListItemBlock()
  },
  inline: {
    // The editor flavour of wikiLink: same node as main's, plus the `parse`
    // rule that turns pasted `[[X]]` text into a link.
    wikiLink: WikiLink,
    linkMention: LinkMention,
    hashTag: HashTag,
    dateMention: DateMention,
    // A picture inside a table cell (#1640). Same node as main's; only the
    // note-relative `src` resolution is added here, for display.
    inlineImage: InlineImage,
    // A tickable checkbox inside a table cell — `checkListItem` is a block and
    // a cell holds inline content only. Same node as main's; only the click
    // handler that flips it is added here.
    inlineCheckbox: InlineCheckbox
  }
})

export type EditorSchema = typeof editorSchema
