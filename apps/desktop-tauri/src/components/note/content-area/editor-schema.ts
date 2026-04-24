import {
  BlockNoteSchema,
  defaultInlineContentSpecs,
  defaultBlockSpecs,
  createCodeBlockSpec
} from '@blocknote/core'
import { codeBlockOptions } from '@blocknote/code-block'
import { createFileBlock } from './file-block'
import { createCalloutBlock } from './callout-block'
import { createYoutubeEmbedBlock } from './youtube-embed-block'
import { createTaskBlock } from './task-block'
import { WikiLink } from './wiki-link'
import { HashTag } from './hash-tag'
import { LinkMention } from './link-mention'

export const editorSchema = BlockNoteSchema.create({
  blockSpecs: {
    ...defaultBlockSpecs,
    codeBlock: createCodeBlockSpec(codeBlockOptions),
    file: createFileBlock(),
    callout: createCalloutBlock(),
    youtubeEmbed: createYoutubeEmbedBlock(),
    taskBlock: createTaskBlock()
  },
  inlineContentSpecs: {
    ...defaultInlineContentSpecs,
    wikiLink: WikiLink,
    hashTag: HashTag,
    linkMention: LinkMention
  }
})

export type EditorSchema = typeof editorSchema
