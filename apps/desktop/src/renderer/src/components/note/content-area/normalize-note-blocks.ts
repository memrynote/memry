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
import { normalizeInlineCheckboxes } from './inline-checkbox-utils'
import { normalizeTaskBlocks } from './task-block/task-block-utils'
import { reportUnclaimedTokens } from './unclaimed-token-telemetry'

export function normalizeNoteBlocks(blocks: Block[]): Block[] {
  let normalized = normalizeWikiLinks(blocks).blocks
  normalized = normalizeLinkMentions(normalized).blocks
  normalized = normalizeDateMentions(normalized).blocks
  // Table cells only, and last of the inline passes: `[ ]` at the head of a
  // cell is literal text on disk (GFM's task-list syntax is list-item only), so
  // nothing upstream can have claimed it — and running after the others means a
  // cell whose token is followed by a wiki link or a mention has already had
  // that half promoted, so this only ever looks at the leading text run.
  normalized = normalizeInlineCheckboxes(normalized).blocks
  const result = normalizeTaskBlocks(normalized as any[]).blocks as Block[]
  // Anything still literal after the chain is a token the note will render
  // broken. Counted, never surfaced — see unclaimed-token-telemetry.ts (#1848).
  reportUnclaimedTokens(result)
  return result
}
