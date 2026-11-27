/**
 * More inputs for the `markdown-seed.json` class, in
 * [`MARKDOWN_SEED_CASES`](./markdown-seed-cases.ts): text that spells a
 * placeholder one of the read path's masks uses. A mask hides a construct
 * behind a placeholder and swaps it back, so each case holds the spelling next
 * to the construct that mask hides, and the document must keep the text as
 * text and still build the construct. Desktop and the core pick placeholders a
 * note cannot spell (`@memry/shared/mask-word`, `markdown_seed/mask_word.rs`).
 */

export const MARKDOWN_SEED_MASK_CASES: ReadonlyArray<{
  name: string
  markdown: string
  pins: string
}> = [
  {
    name: 'placeholder text: table cell code spans',
    markdown: '| `x|MEMRYCSP0X` | `MEMRYCSPSX MEMRYCSPTX` |\n| --- | --- |\n| `a b` | c |',
    pins: 'a code span holding text that spells a cell code span placeholder keeps it, and the spans beside it keep their spaces and pipes'
  },
  {
    name: 'placeholder text: a hard break token on its own line',
    markdown: 'a  \nMEMRYHBK0;\nb',
    pins: 'the line spelling a hard break token is text after the hard break before it'
  },
  {
    name: 'placeholder text: a hard break token opening a line',
    markdown: 'a  \nMEMRYHBK0;b\nc',
    pins: 'the token spelling opens a line of text after a hard break, and a soft break follows it'
  },
  {
    name: 'placeholder text: table probe words before a widened table',
    markdown: 'MEMRYTBL0X\n\n| a |\n| --- |\n| b | MEMRYTBL1X | c |',
    pins: 'a body row wider than the header widens the table whatever text spells the width probe'
  },
  {
    name: 'placeholder text: every other placeholder shape',
    markdown:
      'MEMRYEMO0; MEMRYEMC0; MEMRYEMK0; MEMRYEMU0; MEMRYLNK0X MEMRYCMT0aX MEMRYEMB MEMRYEMBCORE MEMRYTKN0X MEMRYICO0:y:MEMRYICC; MEMRYLINKCARD MEMRYDLT;',
    pins: 'the shapes of the emphasis, link, comment, empty-block, token, colour, link card and details placeholders are text'
  },
  {
    name: 'placeholder text: an empty item line beside the empty block placeholder',
    markdown: '- MEMRYEMBCORE\n-\n- a',
    pins: 'an item that spells the empty-block placeholder keeps it and the empty item beside it stays empty'
  },
  {
    name: 'placeholder text: a details block another app wrote',
    markdown: '<details>\n<summary>x</summary>\nMEMRYDLT;summary>\n</details>',
    pins: 'a details block no toggle claims is text whose `<` is hidden behind a placeholder, and text spelling that placeholder stays as written'
  }
]
