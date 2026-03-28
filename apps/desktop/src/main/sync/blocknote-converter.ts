import { ServerBlockNoteEditor } from '@blocknote/server-util'
import {
  type Block,
  type PartialBlock,
  BlockNoteSchema,
  defaultBlockSpecs,
  createCodeBlockSpec
} from '@blocknote/core'
import { codeBlockOptions } from '@blocknote/code-block'
import type * as Y from 'yjs'
import { CRDT_FRAGMENT_NAME } from '@memry/contracts/ipc-crdt'
import {
  splitMarkdownPreservingBlanks,
  assembleMarkdownWithBlanks,
  type MarkdownSegment
} from '@memry/shared/empty-lines'
import { createLogger } from '../lib/logger'

const log = createLogger('BlockNoteConverter')

const serverSchema = BlockNoteSchema.create({
  blockSpecs: {
    ...defaultBlockSpecs,
    codeBlock: createCodeBlockSpec(codeBlockOptions)
  }
})

let serverEditor: ServerBlockNoteEditor | null = null

function getEditor(): ServerBlockNoteEditor {
  if (!serverEditor) {
    serverEditor = ServerBlockNoteEditor.create({ schema: serverSchema })
  }
  return serverEditor
}

export async function yDocToMarkdown(
  doc: Y.Doc,
  fragmentName = CRDT_FRAGMENT_NAME
): Promise<string | null> {
  try {
    const editor = getEditor()
    const fragment = doc.getXmlFragment(fragmentName)
    const blocks = editor.yXmlFragmentToBlocks(fragment)
    if (blocks.length === 0) return ''
    return await blocksToMarkdownPreserving(editor, blocks as Block[])
  } catch (err) {
    log.error('Yjs-to-markdown conversion failed', err)
    return null
  }
}

export async function markdownToBlocks(markdown: string): Promise<Block[] | null> {
  try {
    const editor = getEditor()
    return await markdownToBlocksPreserving(editor, markdown)
  } catch (err) {
    log.error('Markdown-to-blocks conversion failed', err)
    return null
  }
}

export function blocksToYFragment(blocks: Block[], fragment: Y.XmlFragment): boolean {
  try {
    const editor = getEditor()
    editor.blocksToYXmlFragment(blocks, fragment)
    return true
  } catch (err) {
    log.error('Blocks-to-Yjs conversion failed', err)
    return false
  }
}

export async function markdownToYFragment(
  markdown: string,
  fragment: Y.XmlFragment
): Promise<boolean> {
  const blocks = await markdownToBlocks(markdown)
  if (!blocks) return false
  return blocksToYFragment(blocks, fragment)
}

export async function yFragmentToBlocks(fragment: Y.XmlFragment): Promise<Block[] | null> {
  try {
    const editor = getEditor()
    return editor.yXmlFragmentToBlocks(fragment)
  } catch (err) {
    log.error('Yjs-to-blocks conversion failed', err)
    return null
  }
}

// ---------------------------------------------------------------------------
// Empty-line-preserving conversion helpers
// ---------------------------------------------------------------------------

function isEmptyParagraph(block: Block): boolean {
  if (block.type !== 'paragraph') return false
  const content = block.content as unknown[]
  return !content || content.length === 0
}

function createEmptyParagraph(): Block {
  return {
    type: 'paragraph',
    content: [],
    children: [],
    id: '',
    props: {}
  } as unknown as Block
}

async function markdownToBlocksPreserving(
  editor: ServerBlockNoteEditor,
  markdown: string
): Promise<Block[]> {
  const segments = splitMarkdownPreservingBlanks(markdown)
  const blocks: Block[] = []

  for (const seg of segments) {
    if (seg.type === 'content') {
      const parsed = await editor.tryParseMarkdownToBlocks(seg.text)
      blocks.push(...parsed)
    } else {
      for (let i = 0; i < seg.extraLines; i++) {
        blocks.push(createEmptyParagraph())
      }
    }
  }

  return blocks
}

async function blocksToMarkdownPreserving(
  editor: ServerBlockNoteEditor,
  blocks: Block[]
): Promise<string> {
  const segments: MarkdownSegment[] = []
  let contentGroup: Block[] = []
  let emptyCount = 0

  for (const block of blocks) {
    if (isEmptyParagraph(block)) {
      if (contentGroup.length > 0) {
        const md = await editor.blocksToMarkdownLossy(contentGroup as PartialBlock[])
        segments.push({ type: 'content', text: md })
        contentGroup = []
      }
      emptyCount++
    } else {
      if (emptyCount > 0) {
        segments.push({ type: 'gap', extraLines: emptyCount })
        emptyCount = 0
      }
      contentGroup.push(block)
    }
  }

  if (contentGroup.length > 0) {
    const md = await editor.blocksToMarkdownLossy(contentGroup as PartialBlock[])
    segments.push({ type: 'content', text: md })
  }
  if (emptyCount > 0) {
    segments.push({ type: 'gap', extraLines: emptyCount })
  }

  return assembleMarkdownWithBlanks(segments)
}
