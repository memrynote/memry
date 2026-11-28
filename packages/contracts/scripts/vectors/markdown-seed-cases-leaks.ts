/**
 * More inputs for the `markdown-seed.json` class, in
 * [`MARKDOWN_SEED_CASES`](./markdown-seed-cases.ts): a mask's trigger in a
 * place a block holds a string. A mask hides a construct behind a placeholder
 * while the text is parsed and swaps it back in every string of the blocks, so
 * the document holds the author's bytes in a code fence's language, a link's
 * address, an image's alt and a math block, and never a placeholder.
 */

export const MARKDOWN_SEED_LEAK_CASES: ReadonlyArray<{
  name: string
  markdown: string
  pins: string
}> = [
  {
    name: 'mask in a prop: a comment in a fence info string',
    markdown: '```%% c %%`\nx\n```\n\n- a\n    ```js %% c %%\n    x\n    ```',
    pins: 'the language is the info string as written, comment included, in a fence at the top level and in one under a list item'
  },
  {
    name: 'mask in a prop: a comment in an address, an alt and a formula',
    markdown:
      '[a](https://e.com/%% b %%)\n\n![a %% b %% c](https://e.com/i.png)\n\n$$\nx %% y %% z\n$$',
    pins: 'the link address, the image name and the math source hold the comment as written'
  },
  {
    name: 'mask in a prop: a comment in a bookmark and a video address',
    markdown:
      '![bookmark](https://e.com/a%% c %%b)\n\n![v](https://youtu.be/dQw4w9WgXcQ?t=%% c %%)',
    pins: 'a marker line holding a comment is the block its bytes make, the comment as written in its address'
  },
  {
    name: 'mask in a prop: an address across a hard break',
    markdown: '[a](u  \nv)\n\n> [b](w\\\nx)',
    pins: 'the address is what the parser reads up to its first whitespace: the hard break is no part of it'
  },
  {
    name: 'mask in a prop: details markup in a formula and a spaced address in a summary',
    markdown: '$$\n<details>\n$$\n\n<details>\n<summary>[a](<1 v>)</summary>\n\nx\n\n</details>',
    pins: 'the formula holds the tag as written; the summary link keeps its spaced address whole, with no placeholder in it'
  }
]
