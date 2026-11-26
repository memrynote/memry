/**
 * What a block can be turned into. The block handle's Turn into menu lists
 * these, and the slash menu (`slash-menu-convert.ts`) converts a line in place
 * only between these types, so the two cannot drift.
 *
 * @module note/content-area/turn-into-targets
 */

/** Turn-into targets, in menu order. Heading carries its level as a prop. */
export const TURN_INTO_TARGETS: Array<{
  key: string
  type: string
  props?: Record<string, unknown>
}> = [
  { key: 'paragraph', type: 'paragraph' },
  { key: 'heading1', type: 'heading', props: { level: 1 } },
  { key: 'heading2', type: 'heading', props: { level: 2 } },
  { key: 'heading3', type: 'heading', props: { level: 3 } },
  { key: 'bulletList', type: 'bulletListItem' },
  { key: 'numberedList', type: 'numberedListItem' },
  // A checkbox that stays one, and one that becomes a task. `Task` goes through
  // the editor's own converter after the retype (`checkbox-task-actions.ts`).
  { key: 'checkbox', type: 'checkListItem', props: { plain: true } },
  { key: 'task', type: 'checkListItem', props: { plain: false } },
  { key: 'toggleList', type: 'toggleListItem' },
  { key: 'quote', type: 'quote' },
  { key: 'codeBlock', type: 'codeBlock' },
  { key: 'callout', type: 'callout' }
]
