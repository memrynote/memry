import { createMemrySchema, WikiLink } from '@memry/editor-schema'
import { createFileBlock } from './file-block'
import { createCalloutBlock } from './callout-block'
import { createYoutubeEmbedBlock } from './youtube-embed-block'
import { createBookmarkBlock } from './bookmark-block'
import { createTaskBlock } from './task-block'
import { HashTag } from './hash-tag'
import { DateMention } from './date-mention'

// Built through the shared factory so the main process gets a schema with the
// same node types. Main converts the shared Y.Doc through y-prosemirror, which
// DELETES any element its schema cannot build — a spec registered on one side
// only replicates as data loss, not as a missing style. The inline specs come
// from the factory; only the two whose presentation needs renderer state
// (tag palette, clock/week-start settings) are passed in.
export const editorSchema = createMemrySchema({
  // No `...defaultBlockSpecs` here: the factory already spreads them, and
  // respreading them after it would put BlockNote's plain `codeBlock` back over
  // the syntax-highlighting one the factory installs. Pass overrides only.
  blocks: {
    file: createFileBlock(),
    callout: createCalloutBlock(),
    youtubeEmbed: createYoutubeEmbedBlock(),
    bookmark: createBookmarkBlock(),
    taskBlock: createTaskBlock()
  },
  inline: {
    // The editor flavour of wikiLink: same node as main's, plus the `parse`
    // rule that turns pasted `[[X]]` text into a link.
    wikiLink: WikiLink,
    hashTag: HashTag,
    dateMention: DateMention
  }
})

export type EditorSchema = typeof editorSchema
