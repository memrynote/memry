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
    name: 'fence info string: a backtick in it, blanks around it',
    markdown:
      '```  ``` x\na\n```\n\n``` ```  y\nb\n```\n\n```  `` z\nc\n```\n\n~~~  ``` w\nd\n~~~\n\n```  ```|\ne\n```\n\n- a\n\n    ```  ``` v\n    f\n    ```',
    pins: 'BlockNote trims the language of every fence it opens, and a backtick in the info string of a backtick fence is no reason to keep the blanks of a code span of blanks in it'
  },
  {
    name: 'comment in a summary line that is no toggle',
    markdown:
      '<details>\n<summary><!-- c --></summary>\n\nx\n\n</details>\n\n<details>\n<summary>a <!-- c --> **b** `<!-- d -->` [e<!-- f -->](u)</summary>\n\ny\n\n</details>',
    pins: 'a <!-- comment in the summary line of a <details> block that is no toggle is a comment node among the text of the line, and its bytes in a code span or a link label'
  },
  {
    name: 'an address no markdown writes back as itself',
    markdown:
      '[b]([](u\nv))\n\n![a]([](u\nv))\n\n[b](x(y\nz) w)\n\n![i](x(y z) w)\n\n[b](<1\ny>)\n\n[b](x(y z) w)\n\n`[b](x(y\nz) w)` and `a\n[](u)\nb`',
    pins: 'a link or an image whose address the parse cuts at a blank with a parenthesis open in it, or holds a line break, stays the text it was; an address with a blank and balanced parentheses is the link'
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
  },
  {
    name: 'comment between escaped backticks',
    markdown:
      '\\`%%x%%\\`\n\na \\`%%y%%\\` b\n\n\\\\`%%z%%`\n\n| a |\n|---|\n| \\`%%x%%\\` |\n\n<details>\n<summary>\\`<!-- c -->\\`</summary>\n\nx\n\n</details>',
    pins: 'a backslash makes a backtick text, so a comment between two of them is a comment node; after an escaped backslash the backtick opens a span and the comment is its bytes'
  },
  {
    name: 'comment in a span a run of backticks retries into',
    markdown:
      'a``%%x%%b`c\n\na``%%x%%b`c`\n\n\\``%%x%%`\n\n| a |\n|---|\n| a``%%x%%b`c |\n| ``x ` |\n| ``x ` y |\n| ```x  y` |\n| [](u) `x  y` |\n| [](u)``` x  y` |\n| \\```[](u)\\`[](u)\\` |\n\n```%% a`\n`%%\nc\n```',
    pins: "a run of backticks with no closer of its length retries from each later backtick against the shorter run left, as the parser does, so a comment the span reaches is the span's own bytes; a run that opens a fence line pairs only with its own length; an empty-label link outside such a span is a node, and its brackets make no row unsafe for the span's blanks"
  }
]
