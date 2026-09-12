/* eslint-disable @typescript-eslint/no-explicit-any */

import { substituteTemplatePlaceholders } from '@memry/shared/template-placeholders'
import { createLogger } from '@/lib/logger'
import { isEmptyParagraph, parseMarkdownPreservingBlanks } from './markdown-utils'
import { normalizeNoteBlocks } from './normalize-note-blocks'

const log = createLogger('InsertTemplate')

export interface InsertTemplateArgs {
  editor: any
  content: string
  noteTitle: string
  referenceBlockId: string
  consumeEmptyReference: boolean
  notePath?: string
}

export type InsertTemplateResult =
  { ok: true; insertedBlockIds: string[] } | { ok: false; reason: 'empty' | 'stale-block' }

function withoutBlockIds(node: any): any {
  return {
    ...node,
    id: undefined,
    children: Array.isArray(node.children) ? node.children.map(withoutBlockIds) : node.children
  }
}

export async function insertTemplateBlocks({
  editor,
  content,
  noteTitle,
  referenceBlockId,
  consumeEmptyReference,
  notePath
}: InsertTemplateArgs): Promise<InsertTemplateResult> {
  const markdown = substituteTemplatePlaceholders(content, noteTitle)
  if (!markdown.trim()) return { ok: false, reason: 'empty' }

  const parsed = await parseMarkdownPreservingBlanks(editor, markdown, notePath)
  const blocks = normalizeNoteBlocks(parsed).map(withoutBlockIds)
  if (blocks.length === 0) return { ok: false, reason: 'empty' }

  const reference = editor.getBlock(referenceBlockId)
  if (!reference) {
    log.warn('Reference block disappeared while parsing the template', { referenceBlockId })
    return { ok: false, reason: 'stale-block' }
  }

  const result =
    consumeEmptyReference && isEmptyParagraph(reference)
      ? editor.replaceBlocks([reference], blocks)
      : editor.insertBlocks(blocks, reference, 'after')

  const inserted: any[] = Array.isArray(result) ? result : (result?.insertedBlocks ?? [])
  if (inserted[0]) editor.setTextCursorPosition(inserted[0], 'start')

  return { ok: true, insertedBlockIds: inserted.map((block) => block?.id).filter(Boolean) }
}
