/* eslint-disable @typescript-eslint/no-explicit-any */

/**
 * Renderer twin of the main process's source-preserving serialization
 * (`blocknote-converter.ts`, #1915), for the path where the renderer itself
 * owns persistence: no shared doc, so the source lives with whoever loaded
 * the note and is handed back at save.
 */

import { type Block } from '@blocknote/core'
import { restoreMarkdownSource } from '@memry/shared/markdown-source'
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
 * Call once the loaded markdown is in the editor: the source to keep, or
 * `null` when the editor already serializes it byte for byte.
 */
export async function recordLoadedMarkdownSource(
  editor: any,
  source: string
): Promise<string | null> {
  const canonical = await serializeBlocksPreservingBlanks(editor, editor.document)
  return canonical === source ? null : source
}

/** The bytes to save: the author's where the document did not change, house style where it did. */
export async function serializeMarkdownPreservingSource(
  editor: any,
  blocks: Block[],
  source: string | null,
  notePath?: string
): Promise<string> {
  const canonical = await serializeBlocksPreservingBlanks(editor, blocks)
  return restoreMarkdownSource(canonical, source, (markdown) =>
    canonicalizeMarkdown(editor, markdown, notePath)
  )
}
