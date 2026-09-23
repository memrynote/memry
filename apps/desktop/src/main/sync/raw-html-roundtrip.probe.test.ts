/**
 * Probe: what markdown → Y.Doc → markdown does to raw HTML (#1883, and the
 * wider hole behind it).
 *
 * The `<details>` family is out of that hole as of #1883's fix — the toggle
 * splitter hides the `<` of every `<details>`/`<summary>` line it declines, so
 * those bytes reach the parser as text and come back whole.
 *
 * The hole itself narrowed sharply with BlockNote 0.51, whose rewritten
 * markdown parser converts much of the HTML the old one discarded: `<img>`,
 * `<video>`, `<hr>`, `<a href>` and `<table>` now come back as their markdown
 * equivalents instead of as nothing, and a `<div>` keeps its inner text rather
 * than taking the note's whole body with it. What is left below is the
 * genuinely unmappable remainder — `<iframe>`, `<script>`, a bare comment.
 * The values here were re-measured against 0.54, not adjusted by hand.
 *
 * Nothing in this file is a promise: it is still a record of what the pipeline
 * does today, and the point is that it goes red when that moves.
 *
 * Note that the improvement direction matters for the vault. An HTML-only body
 * used to be emptied outright on the first write-back after an edit; most of
 * those bodies now survive.
 *
 * The pair below is exactly what the app runs — `markdownToYFragment` seeds the
 * doc on note open, `yDocToMarkdown` re-serializes the WHOLE doc on the first
 * write-back after that. So `pass1` is the bytes that land in the user's file
 * the first time anything touches a note written by hand or by Obsidian, and
 * `pass2` is what a second open of that file produces.
 *
 * `pass1`/`pass2` record CURRENT behavior, not desired behavior. This file is
 * an instrument: it goes red when the behavior moves, which is the point. A
 * `null` means "byte-identical to the input".
 *
 * Since #1915 the pair above also keeps the author's bytes beside the doc and
 * gives them back for every region the document has not changed, so a note
 * that is merely opened comes back whole — every probe here, HTML-only bodies
 * included. `onePass` clears that record so the probes keep measuring the
 * hole itself, which is what an EDITED region still falls into; the last
 * describe asserts the untouched path over the same corpus.
 */

import { describe, expect, it } from 'vitest'
import * as Y from 'yjs'
import { CRDT_FRAGMENT_NAME } from '@memry/contracts/ipc-crdt'
import { serializeToggleBlock } from '@memry/editor-schema/blocks'
import { writeMarkdownSourceToYDoc } from '@memry/shared/markdown-source'
import { markdownToYFragment, yDocToMarkdown } from './blocknote-converter'

async function onePass(markdown: string, { preserveSource = false } = {}): Promise<string> {
  const doc = new Y.Doc()
  const ok = await markdownToYFragment(markdown, doc.getXmlFragment(CRDT_FRAGMENT_NAME))
  expect(ok, 'markdown reached the doc').toBe(true)
  if (!preserveSource) writeMarkdownSourceToYDoc(doc, null)
  const out = await yDocToMarkdown(doc)
  expect(out, 'the doc serialized back at all').not.toBeNull()
  return out as string
}

interface Probe {
  name: string
  markdown: string
  /** Output of the first round-trip; `null` means identical to the input. */
  pass1: string | null
  /** Output of a second round-trip over `pass1`; `null` means identical to it. */
  pass2?: string
}

/**
 * A note whose body is ONLY an HTML block. Most of these now keep their
 * content: 0.51's parser maps the tag onto a block where it can, so the
 * wrapper goes and the text, image or table stays.
 *
 * The three that still empty have nothing to map onto. For those, pass 1
 * leaves three newlines where the block was, pass 2 turns those into the empty
 * string, and `yDocToMarkdown`'s empty-conversion guard never fires because
 * the fragment really does hold the (empty) paragraphs it converted.
 */
const HTML_ONLY_BODY: Probe[] = [
  { name: '<div> on one line', markdown: '<div class="x">Body</div>', pass1: 'Body' },
  { name: '<p> paragraph', markdown: '<p>Body</p>', pass1: 'Body' },
  { name: '<center> block', markdown: '<center>Body</center>', pass1: 'Body' },
  {
    // Kept verbatim: the parser has no figure block, and the whole thing is
    // one inline HTML run rather than a block it would drop.
    name: '<figure> with a caption',
    markdown: '<figure>\n<img src="a.png">\n<figcaption>Cap</figcaption>\n</figure>',
    pass1: '<figure><img src="a.png"><figcaption>Cap</figcaption></figure>'
  },
  {
    // Becomes a real markdown table, header row and all.
    name: 'raw HTML table',
    markdown: '<table>\n<tr><td>a</td></tr>\n</table>',
    pass1: '|   |\n| - |\n| a |'
  },
  {
    name: '<iframe> embed',
    markdown: '<iframe src="https://example.com"></iframe>',
    pass1: '\n\n\n',
    pass2: ''
  },
  { name: '<video> embed', markdown: '<video src="a.mp4" controls></video>', pass1: '![](a.mp4)' },
  { name: 'raw <img>', markdown: '<img src="a.png" alt="A">', pass1: '![A](a.png)' },
  { name: '<hr /> self-closing', markdown: '<hr />', pass1: '***' },
  { name: '<br> alone on a line', markdown: '<br>', pass1: '' },
  { name: 'a plain HTML comment', markdown: '<!-- a note to self -->', pass1: '\n\n\n', pass2: '' },
  { name: '<script> block', markdown: '<script>alert(1)</script>', pass1: '\n\n\n', pass2: '' }
]

/** With markdown around it, the tags go and the inner text stays. */
const BLOCK_LEVEL_IN_CONTEXT: Probe[] = [
  {
    name: '<div> wrapper around a blank-line-separated body',
    markdown: '<div class="x">\n\nBody\n\n</div>',
    pass1: 'Body'
  },
  {
    // The inner text used to go with the wrapper, taking a paragraph out of
    // the middle of the note; it stays now.
    name: 'html block between two paragraphs',
    markdown: 'Before\n\n<div class="x">Body</div>\n\nAfter',
    pass1: 'Before\n\nBody\n\nAfter'
  },
  {
    name: 'blockquote whose only content is html',
    markdown: '> <div>Body</div>',
    pass1: '> Body'
  }
]

/**
 * An inline tag with no equivalent loses its markup and keeps its text. The
 * ones the editor does model — `<a href>`, `<u>`, `<br>` — now survive as the
 * link, the underline and the line break they always meant.
 */
const INLINE_LEVEL: Probe[] = [
  { name: '<kbd>', markdown: 'Press <kbd>Cmd</kbd> now.', pass1: 'Press Cmd now.' },
  { name: '<sup>', markdown: 'Text<sup>1</sup> here.', pass1: 'Text1 here.' },
  {
    // Underline is a real style in the schema, and the span is the spelling
    // Memry already writes for it.
    name: '<u>',
    markdown: 'An <u>underlined</u> word.',
    pass1: 'An <span style="text-decoration:underline">underlined</span> word.'
  },
  { name: '<mark>', markdown: 'A <mark>marked</mark> word.', pass1: 'A marked word.' },
  {
    name: '<abbr title>',
    markdown: 'Use <abbr title="HyperText">HTML</abbr>.',
    pass1: 'Use HTML.'
  },
  {
    name: '<a href> keeps the destination',
    markdown: 'See <a href="https://example.com">this</a>.',
    pass1: 'See [this](https://example.com).'
  },
  { name: '<br> mid-paragraph', markdown: 'One<br>Two', pass1: 'One\nTwo' },
  { name: 'in a list item', markdown: '- <kbd>A</kbd> item', pass1: '- A item' },
  { name: 'in a heading', markdown: '# Title <sup>x</sup>', pass1: '# Title x' },
  // The entity is no longer decoded on the way through, so the author's bytes
  // come back exactly as written.
  { name: 'an HTML entity is left alone', markdown: 'A &amp; B', pass1: null }
]

const SURVIVORS: Probe[] = [
  {
    name: 'raw HTML inside a fenced code block',
    markdown: '```html\n<div class="x">Body</div>\n```',
    pass1: null
  },
  { name: 'raw HTML inside inline code', markdown: 'Use `<div>` here.', pass1: null },
  {
    name: "Memry's own toggle, terminated",
    markdown: serializeToggleBlock('Summary', 'Body'),
    pass1: null
  },
  {
    // Every `<details>` line the toggle splitter declines is escaped on its way
    // into the markdown parser, so the whole family now survives: a foreign
    // block, one holding markdown, one nested in a Memry toggle, and the
    // unterminated shape #1883 was filed for.
    name: 'bare <details> written by hand',
    markdown: '<details>\n<summary>Foreign</summary>\n\nBody\n\n</details>',
    pass1: null
  },
  {
    name: 'bare <details> holding a markdown list',
    markdown: '<details>\n<summary>S</summary>\n\n- one\n- two\n\n</details>',
    pass1: null
  },
  {
    name: 'bare <details> nested in a Memry toggle body',
    markdown: serializeToggleBlock(
      'Summary',
      '<details>\n<summary>In</summary>\n\nX\n\n</details>'
    ),
    pass1: null
  },
  {
    name: 'unterminated Memry toggle',
    markdown: '<details data-memry-toggle>\n<summary>Unterminated</summary>\n\nBody',
    pass1: null
  },
  {
    name: "Memry's own file-block marker",
    markdown:
      '<!-- file:{"url":"memry-file://v/a.pdf","name":"a.pdf","size":12,"mimeType":"application/pdf"} -->',
    pass1: null
  },
  {
    name: "Memry's own colors marker",
    markdown: '<!-- colors:{"backgroundColor":"blue"} -->\nBody',
    pass1: null
  },
  {
    name: 'an inline color span in the exact bytes Memry writes',
    markdown: 'A <span style="color:#ff0000">red</span> word.',
    pass1: null
  },
  {
    name: 'a hand-written color span is re-spaced, not dropped',
    markdown: 'A <span style="color: #ff0000">red</span> word.',
    pass1: 'A <span style="color:#ff0000">red</span> word.'
  }
]

function run(title: string, probes: Probe[]): void {
  describe(title, () => {
    it.each(probes)('$name', async ({ markdown, pass1, pass2 }) => {
      const once = await onePass(markdown)
      expect(once, 'first round-trip').toBe(pass1 ?? markdown)
      expect(await onePass(once), 'second round-trip').toBe(pass2 ?? once)
    })
  })
}

describe('raw HTML through the write-back round-trip', () => {
  run('an HTML-only body is emptied outright', HTML_ONLY_BODY)
  run('a block-level tag is dropped, its inner text kept', BLOCK_LEVEL_IN_CONTEXT)
  run('an inline tag is dropped, its text kept', INLINE_LEVEL)
  run('what survives', SURVIVORS)
})

describe('raw HTML through the round-trip, with the author’s bytes beside the doc (#1915)', () => {
  const every = [...HTML_ONLY_BODY, ...BLOCK_LEVEL_IN_CONTEXT, ...INLINE_LEVEL, ...SURVIVORS]
  it.each(every)('$name survives untouched', async ({ markdown }) => {
    const once = await onePass(markdown, { preserveSource: true })
    expect(once, 'first round-trip').toBe(markdown)
    expect(await onePass(once, { preserveSource: true }), 'second round-trip').toBe(markdown)
  })
})
