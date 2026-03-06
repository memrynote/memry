import { ServerBlockNoteEditor } from '@blocknote/server-util'
import type { Block, PartialBlock } from '@blocknote/core'
import type * as Y from 'yjs'
import { CRDT_FRAGMENT_NAME } from '@memry/contracts/ipc-crdt'
import { createLogger } from '../lib/logger'

const log = createLogger('BlockNoteConverter')

let serverEditor: ServerBlockNoteEditor | null = null

function getEditor(): ServerBlockNoteEditor {
  if (!serverEditor) {
    serverEditor = ServerBlockNoteEditor.create()
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
    return await editor.blocksToMarkdownLossy(blocks as PartialBlock[])
  } catch (err) {
    log.error('Yjs-to-markdown conversion failed', err)
    return null
  }
}

export async function markdownToBlocks(markdown: string): Promise<Block[] | null> {
  try {
    const editor = getEditor()
    return await editor.tryParseMarkdownToBlocks(markdown)
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
