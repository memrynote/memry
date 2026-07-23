/**
 * The note editor's block normalization chain, in one place.
 *
 * Parsing a note's markdown is only half the load: BlockNote returns plain
 * paragraphs/checkboxes, and these passes turn the markdown markers back into
 * real blocks and inline content — `[[wiki links]]`, link mentions, date
 * mentions, and `{task:<id>}` checkboxes into the taskBlock renderer.
 *
 * Any surface that renders a note (the editor via use-editor-sync, a read-only
 * canvas card via canvas-note-body) MUST run the same chain in the same order,
 * or the same markdown renders differently depending on where you look at it.
 * Hash tags are deliberately not here: they need the note's tag list and colour
 * map, which only the editor has.
 */
/* eslint-disable @typescript-eslint/no-explicit-any */

import type { Block } from '@blocknote/core'
import { normalizeWikiLinks } from './wiki-link-utils'
import { normalizeLinkMentions } from './link-mention-utils'
import { normalizeDateMentions } from './date-mention-utils'
import { normalizeTaskBlocks } from './task-block/task-block-utils'

export function normalizeNoteBlocks(blocks: Block[]): Block[] {
  let normalized = normalizeWikiLinks(blocks).blocks
  normalized = normalizeLinkMentions(normalized).blocks
  normalized = normalizeDateMentions(normalized).blocks
  return normalizeTaskBlocks(normalized as any[]).blocks as Block[]
}
