/**
 * The word every text mask puts inside its placeholders (`MEMRYHBK<word>0;`),
 * drawn once per process.
 *
 * A mask hides a construct behind a placeholder before the parse and swaps it
 * back after, so a note whose own text spells a placeholder would have that
 * text eaten or swapped for a construct. With a word the note cannot know, no
 * text spells one. That holds because a placeholder never leaves the process
 * that made it: the restore runs in the same process as the mask.
 */
export const MASK_WORD = String.fromCharCode(
  ...crypto.getRandomValues(new Uint8Array(12)).map((byte) => 65 + (byte % 26))
)
