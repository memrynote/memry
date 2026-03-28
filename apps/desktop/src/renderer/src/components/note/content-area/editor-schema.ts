import {
  BlockNoteSchema,
  defaultInlineContentSpecs,
  defaultBlockSpecs,
  createCodeBlockSpec
} from '@blocknote/core'
import { codeBlockOptions } from '@blocknote/code-block'
import { createFileBlock } from './file-block'
import { createCalloutBlock } from './callout-block'
import { WikiLink } from './wiki-link'
import { HashTag } from './hash-tag'

export const editorSchema = BlockNoteSchema.create({
  blockSpecs: {
    ...defaultBlockSpecs,
    codeBlock: createCodeBlockSpec(codeBlockOptions),
    file: createFileBlock(),
    callout: createCalloutBlock()
  },
  inlineContentSpecs: {
    ...defaultInlineContentSpecs,
    wikiLink: WikiLink,
    hashTag: HashTag
  }
})

export type EditorSchema = typeof editorSchema
