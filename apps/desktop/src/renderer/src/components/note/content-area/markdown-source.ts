/* eslint-disable @typescript-eslint/no-explicit-any */

/**
 * Renderer twin of the main process's source-preserving serialization
 * (`blocknote-converter.ts`, #1915), for the path where the renderer itself
 * owns persistence: no shared doc, so the record lives with whoever loaded
 * the note and is handed back at save.
 */

import { type Block } from '@blocknote/core'
import {
  recordMarkdownSource,
  restoreMarkdownSource,
  type MarkdownSourceRecord
} from '@memry/shared/markdown-source'
import { parseMarkdownPreservingBlanks, serializeBlocksPreservingBlanks } from './markdown-utils'
import { normalizeNoteBlocks } from './normalize-note-blocks'

/** House style on this pipeline: parse, promote, serialize. The proof oracle. */
export async function canonicalizeMarkdown(
  editor: any,
  markdown: string,
  notePath?: string
): Promise<string> {
  const parsed = await parseMarkdownPreservingBlanks(editor, markdown, notePath)
  return serializeBlocksPreservingBlanks(editor, normalizeNoteBlocks(parsed))
}

/**
 * Call once the loaded markdown is in the editor: what the file said, and what
 * the editor now serializes it to. `null` when the two agree.
 */
export async function recordLoadedMarkdownSource(
  editor: any,
  source: string
): Promise<MarkdownSourceRecord | null> {
  return recordMarkdownSource(
    source,
    await serializeBlocksPreservingBlanks(editor, editor.document)
  )
}

/** The bytes to save: the author's where the document did not change, house style where it did. */
export async function serializeMarkdownPreservingSource(
  editor: any,
  blocks: Block[],
  record: MarkdownSourceRecord | null,
  notePath?: string
): Promise<string> {
  const canonical = await serializeBlocksPreservingBlanks(editor, blocks)
  return restoreMarkdownSource(canonical, record, (markdown) =>
    canonicalizeMarkdown(editor, markdown, notePath)
  )
}
