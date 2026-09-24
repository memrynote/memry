/**
 * The shared round-trip conformance corpus (#1848).
 *
 * One table, asserted against BOTH serializers: the renderer pipeline
 * (markdown-utils.ts + normalize-note-blocks.ts, in the renderer suite) and the
 * main/CRDT pipeline (blocknote-converter.ts, in the main suite). Each case's
 * `markdown` is the canonical on-disk bytes; both suites assert their own
 * round-trip returns exactly those bytes, which is what makes cross-serializer
 * agreement a byte-equality fact rather than an assumption — two pipelines that
 * each reproduce the same constant necessarily agree with each other.
 *
 * `pending` marks a case that FAILS against current main because the fix it
 * asserts ships in the named issue (siblings of epic #1843, and #2365). The
 * suites run those with `it.fails`, so the moment the fix lands the inverted
 * expectation turns red and forces the flag's removal. Remove the flag, never
 * the case.
 */

import { serializeLinkMentionToken } from './inline/link-mention'
import {
  serializeCalloutBlock,
  serializeMathBlock,
  serializeToggleBlock,
  serializeWhiteboard
} from './blocks/markdown'
import { serializeDateMentionToken, type DateMentionData } from '@memry/shared/date-mention'

export interface RoundtripCase {
  name: string
  /** Canonical on-disk bytes: round-tripping them must be identity. */
  markdown: string
  /**
   * Set only when `markdown` is a spelling the block tree cannot tell apart
   * from another case's, so identity is unreachable for one of the two on the
   * house-style path. That path must produce exactly these bytes and they must
   * then round-trip to themselves, which pins both the rewrite and the fact
   * that it happens once. Anything reachable by identity states no `canonical`
   * — this is not an escape hatch for a serializer that merely reflows.
   *
   * The source-preserving path (#1915) ignores this field: an untouched
   * document comes back as `markdown`, always.
   */
  canonical?: string
  /** Sibling issue that must land before the marked pipeline can pass. */
  pending?: { renderer?: number; main?: number }
}

const MENTION_URLS = [
  'https://example.com/a_b_c',
  'https://example.com/a*b*c',
  'https://example.com/a!b',
  'https://example.com/~user',
  "https://example.com/it's",
  'https://en.wikipedia.org/wiki/Rust_(programming_language)',
  'https://example.com/100%25',
  'https://example.com/?a=1&b=2&c=x_y',
  'https://example.com/page#section',
  'https://example.com/a b',
  'https://example.com/日本語/ünïcode',
  "https://example.com/x_(y)*z!~'&=#%20 end)"
] as const

function dateMentionData(overrides: Partial<DateMentionData> = {}): DateMentionData {
  return {
    anchorId: 'a1',
    dateISO: '2026-08-14T09:00:00.000Z',
    hasTime: true,
    dateFormat: 'relative',
    remind: 'none',
    timeFormat: 'system',
    ...overrides
  }
}

/**
 * An anchor id whose bytes (0xFF runs, 0xFB 0xEF 0xBE) forced base64url `__`
 * and `--` emphasis runs into the token under the pre-#1845 alphabet — the
 * exact characters remark escaped into unparseable tokens. #1866 closed the
 * alphabet (the two odd base64 symbols are now `,` and `;`), so the same
 * hostile bytes must yield a token with no emphasis character at all;
 * asserted here so a future encoder change that reopens the alphabet fails
 * the corpus loudly instead of silently reviving the bug.
 */
function anchorIdWithEmphasisRuns(): string {
  const anchorId = 'x' + 'ÿ'.repeat(4) + 'ûï¾'.repeat(3)
  const token = serializeDateMentionToken(dateMentionData({ anchorId }))
  if (token.includes('_') || token.includes('-')) {
    throw new Error('the date token alphabet emits markdown emphasis characters again')
  }
  return anchorId
}

const mention = (url: string): string => serializeLinkMentionToken(url)
const date = (data: DateMentionData): string => serializeDateMentionToken(data)

const mentionCases: RoundtripCase[] = [
  ...MENTION_URLS.map((url) => ({
    name: `link mention url ${url}`,
    markdown: `Intro ${mention(url)} outro.`
  })),
  {
    // encodeURIComponent left `!` and `_` raw, and `_` next to punctuation is
    // exactly where remark-stringify escaped it into the token before #1867
    // closed the alphabet.
    name: 'link mention url with underscore next to punctuation',
    markdown: `Intro ${mention('https://example.com/!_bang/x.y_~z')} outro.`
  }
]

const dateCases: RoundtripCase[] = [
  { name: 'date pill in body text', markdown: `Before ${date(dateMentionData())} after.` },
  {
    name: 'date pill whose payload forced emphasis runs pre-#1845',
    markdown: `Before ${date(dateMentionData({ anchorId: anchorIdWithEmphasisRuns() }))} after.`
  },
  {
    name: 'date pill with a reminder, whole paragraph',
    markdown: date(dateMentionData({ remind: '1d', hasTime: false, dateFormat: 'full' }))
  },
  {
    name: 'two date pills in one line',
    markdown: `${date(dateMentionData())} and ${date(dateMentionData({ anchorId: 'b2' }))}`
  }
]

const calloutCases: RoundtripCase[] = [
  ...(['info', 'warning', 'error', 'success'] as const).map((type) => ({
    name: `${type} callout`,
    markdown: serializeCalloutBlock(type, 'Heads up')
  })),
  {
    name: 'callout with a multi-line body',
    markdown: serializeCalloutBlock('info', 'One\nTwo')
  },
  {
    name: 'foreign > [!note] callout passes through untouched',
    markdown: '> [!note]\n> An Obsidian note callout'
  },
  {
    name: 'foreign > [!tip] callout passes through untouched',
    markdown: '> [!tip]\n> An Obsidian tip callout'
  },
  {
    name: 'callout with a title after the marker',
    markdown: '> [!info] Title here\n> Body'
  },
  {
    // #1875 declines blank-`>`-line shapes from the callout claim, so the run
    // stays a blockquote; #1881 is what makes that blockquote keep its blank
    // separator instead of collapsing to `> [!info]\n> One\n> Two`.
    name: 'callout with a multi-paragraph body',
    markdown: '> [!info]\n> One\n>\n> Two'
  },
  {
    name: 'nested foreign callouts pass through untouched',
    markdown:
      '> [!note] Outer callout\n> Outer body text\n>\n> > [!warning] Inner callout\n> > Inner body text'
  },
  {
    name: 'plain quote with a blank separator line',
    markdown: '> One\n>\n> Two'
  },
  {
    name: 'quote with a fenced code block after a blank line',
    markdown: '> Intro\n>\n> ```ts\n> const x = 1\n> ```'
  },
  {
    name: 'quote with a list after a blank line',
    markdown: '> Intro\n>\n> - one\n> - two'
  },
  {
    // #1877's defect one splitter over: the renderer reads callout and quote
    // runs BEFORE the blank-line scanner, so a gap at their edge is trimmed
    // away. Main reads them after, and keeps it.
    name: 'extra blank line next to a callout survives',
    markdown: `Before\n\n\n${serializeCalloutBlock('info', 'Body')}\n\n\nAfter`,
    pending: { renderer: 1892 }
  },
  {
    // Lazy continuation, the one shape in this group that cannot be identity:
    // it parses to the same block tree as `plain quote with a blank separator
    // line` nested, and the tree has nowhere to record which of the two
    // spellings it was read from, so only one of them can round-trip. It
    // normalizes onto the separator form in one write and stops moving. What
    // was actually at stake is the `>` level: before this, the flat fallback
    // deleted it and the run came back `> Outer\n> Inner`.
    name: 'lazily continued nested quote normalizes onto the separator form',
    markdown: '> Outer\n> > Inner',
    canonical: '> Outer\n>\n> > Inner'
  },
  {
    // The same normalization on the shape #1881 was filed over: an Obsidian
    // callout nested lazily. The flat fallback used to demote it to literal
    // `[!warning]` text in the outer quote.
    name: 'lazily continued nested callout keeps its nesting',
    markdown: '> Outer\n> > [!warning] Inner\n> > Inner body',
    canonical: '> Outer\n>\n> > [!warning] Inner\n> > Inner body'
  }
]

const toggleCases: RoundtripCase[] = [
  { name: 'empty toggle', markdown: serializeToggleBlock('Summary', '') },
  { name: 'toggle with a body', markdown: serializeToggleBlock('Summary', 'Body line') },
  {
    name: 'nested toggles',
    markdown: serializeToggleBlock('Outer', serializeToggleBlock('Inner', 'Deep body'))
  },
  {
    name: 'toggle body with blank lines',
    markdown: serializeToggleBlock('Summary', 'One\n\nTwo')
  },
  {
    name: 'toggle body with a code fence',
    markdown: serializeToggleBlock('Summary', '```ts\nconst x = 1\n```')
  },
  {
    name: 'toggle body with an image',
    markdown: serializeToggleBlock(
      'Summary',
      '![pic.png](memry-file://local/v/attachments/n/pic.png)'
    )
  },
  {
    // splitMarkdownByToggles declines the region, but the leftover raw-HTML
    // lines then hit BlockNote's parser, which drops them (#1883).
    name: 'unterminated toggle stays literal markdown',
    markdown: '<details data-memry-toggle>\n<summary>Unterminated</summary>\n\nBody'
  },
  {
    name: 'expanded toggle keeps its open attribute',
    markdown: serializeToggleBlock('Summary', 'Body line', null, true)
  },
  {
    name: 'expanded toggle nested in a collapsed one',
    markdown: serializeToggleBlock('Outer', serializeToggleBlock('Inner', 'Deep body', null, true))
  },
  {
    // splitMarkdownByToggles trims the gap out of its markdown segments before
    // the blank-line scanner runs, so the user's spacing collapses on save.
    name: 'extra blank line next to a toggle survives',
    markdown: `Before\n\n\n${serializeToggleBlock('Summary', 'Body line')}\n\n\nAfter`
  },
  {
    // A gap with a toggle on BOTH sides: the whole run is one seam, so a
    // splitter that counted it twice would double the user's spacing.
    name: 'extra blank line between two toggles survives',
    markdown: `${serializeToggleBlock('A', 'a')}\n\n\n${serializeToggleBlock('B', 'b')}`
  },
  {
    name: 'two extra blank lines before a toggle survive',
    markdown: `Before\n\n\n\n${serializeToggleBlock('Summary', 'Body line')}`
  },
  {
    // The colors marker sits between the gap and the toggle, and finding it
    // must not eat the gap on the way past.
    name: 'extra blank line before a colored toggle survives',
    markdown: `Before\n\n\n${serializeToggleBlock('Summary', 'Body line', '<!-- colors:{"backgroundColor":"blue"} -->')}`
  },
  {
    // No `<summary>` at all is the other way readToggleRegion declines, and
    // the open line is dropped by the same parser (#1883).
    name: 'unterminated toggle with no summary keeps its open line',
    markdown: '<details data-memry-toggle>\n\nBody'
  },
  {
    name: 'unterminated expanded toggle keeps its open and summary lines',
    markdown: '<details data-memry-toggle open>\n<summary>Unterminated</summary>\n\nBody'
  },
  {
    // A `<details>` without our attribute is somebody else's bytes — Obsidian's
    // usually. It was never claimed as a toggle, and it was never preserved
    // either: all three markup lines went to the same parser that drops raw
    // HTML, so a hand-written collapsible section came back as its body alone.
    name: 'foreign details block stays the bytes its author wrote',
    markdown: '<details>\n<summary>Foreign</summary>\n\nBody\n\n</details>'
  },
  {
    name: 'orphan closing details tag stays literal markdown',
    markdown: 'Body\n\n</details>'
  },
  {
    // A backslash already in front of a bracket pairs with the escape the
    // splitter adds, so `\<` became `\\<`: one literal backslash, and `<path>`
    // raw again for the parser to drop.
    name: 'declined details markup keeps a backslash next to its bracket',
    markdown: '<details data-memry-toggle>\n<summary>C:\\<path></summary>\n\nBody'
  },
  {
    name: 'declined details markup keeps a backslash that ends the line',
    markdown: '<details data-memry-toggle>\n<summary>ends\\</summary>\n\nBody'
  },
  {
    // The other side of that fix: doubling every backslash must not change a
    // line whose backslashes are nowhere near a bracket. This case passes
    // before and after, and fails if the escaping ever over-reaches.
    name: 'declined details markup keeps a backslash away from its bracket',
    markdown: '<details>\n<summary>C:\\Users\\me</summary>\n\nBody\n\n</details>'
  }
]

const mathCases: RoundtripCase[] = [
  { name: 'math block', markdown: serializeMathBlock('E = mc^2') },
  {
    name: 'multi-line math block',
    markdown: serializeMathBlock('\\begin{aligned}\na &= b + c \\\\\nd &= e\n\\end{aligned}')
  },
  {
    // The block a slash-menu insert writes before anything is typed. It must
    // survive a save/open cycle as a block, not decay into two `$$` lines.
    name: 'empty math block',
    markdown: serializeMathBlock('')
  },
  {
    // Backslashes, braces, `_` and `^` are markdown-significant everywhere else
    // in a note; inside the fence nothing may be escaped.
    name: 'math block with emphasis characters in its source',
    markdown: serializeMathBlock('\\frac{a_1}{b^2} \\cdot \\sum_{i=0}^{n} x_i')
  },
  {
    name: 'math block between paragraphs',
    markdown: `Before\n\n${serializeMathBlock('x^2 + y^2 = z^2')}\n\nAfter`
  },
  {
    name: 'math block in a toggle body',
    markdown: serializeToggleBlock('Summary', serializeMathBlock('E = mc^2'))
  },
  {
    // `$$` is somebody else's notation too. A one-line span is not the shape
    // Memry writes, so it stays the paragraph its author wrote.
    name: 'one-line $$ span passes through untouched',
    markdown: 'Einstein wrote $$E = mc^2$$ in 1905.'
  },
  {
    name: 'a fence glued to the paragraph above it stays text',
    markdown: 'Cost\n$$\n5\n$$'
  },
  {
    name: 'an unterminated fence stays text',
    markdown: '$$\nE = mc^2'
  },
  {
    // Tagged, because an UNTAGGED fence is a different bug: the renderer
    // pipeline stamps the schema's default language on one and main clears it
    // again (`restoreUntaggedFenceLanguages`), so a bare ``` here would assert
    // that gap rather than the math claim.
    name: 'a math fence inside a code block stays code',
    markdown: '```text\n$$\nE = mc^2\n$$\n```'
  }
]

/**
 * Table bytes are the form the serializers emit — remark pads every cell to the
 * column width, so the canonical form of a table is the padded one.
 */
function tableOf(header: [string, string], row: [string, string]): string {
  const width = (i: 0 | 1): number => Math.max(header[i].length, row[i].length, 3)
  const pad = (text: string, i: 0 | 1): string => text.padEnd(width(i))
  return [
    `| ${pad(header[0], 0)} | ${pad(header[1], 1)} |`,
    `| ${'-'.repeat(width(0))} | ${'-'.repeat(width(1))} |`,
    `| ${pad(row[0], 0)} | ${pad(row[1], 1)} |`
  ].join('\n')
}

const containerCases: RoundtripCase[] = [
  {
    // A cell serializes its inline content through ProseMirror's `toDOM`, which
    // BlockNote builds from `render` — so before #1865 the renderer's rich
    // linkMention chip was the serializer here, and this row came back as
    // `[example.com](https://example.com/plain)`: the token, and the domain,
    // title, favicon and siteName riding on it, gone from disk. The date
    // mention shares the row because it always survived — its renderer render
    // emits the token — which is what makes the mention half the measurement
    // rather than a guess about tables in general.
    name: 'mention and date tokens in table cells',
    markdown: tableOf(['a', 'b'], [mention('https://example.com/plain'), date(dateMentionData())])
  },
  {
    // Same hole, first instance: the rich wikiLink render emits the ALIAS, so
    // `[[Roadmap]]` was written back as bare `Roadmap` and the link never came
    // back. `#work` is here for the same reason the date mention is above — an
    // unstyled hash tag's render is already its own text, so it survived, and a
    // row where one cell breaks and the other does not is what pins the cause
    // to the spec's render rather than to the table serializer.
    name: 'wiki link and hash tag in table cells',
    markdown: tableOf(['a', 'b'], ['[[Roadmap]]', '#work'])
  },
  {
    // The two inline nodes #1865 did not name. The checkbox is the one that
    // broke on the 0.51 serializer rewrite (`<input>` is neither element-with-
    // text nor text, so `| [x] task |` came back `| task |`); the image shares
    // the row because its render and its on-disk form happen to agree, which
    // makes it the control.
    name: 'inline checkbox and inline image in table cells',
    markdown: tableOf(['a', 'b'], ['[x] done', '![alt](img.png)'])
  },
  {
    // The escaped pipe is the only spelling of an aliased link that survives a
    // cell: 0.51's parser treats a bare `|` as the cell delimiter. On 0.47.1
    // this row was not a fixed point at all, so it is pinned now that it is.
    name: 'aliased wiki link and marked runs in table cells',
    markdown: tableOf(['a', 'b'], ['[[Roadmap\\|the plan]]', '**bold** *it* ~~s~~'])
  },
  {
    // Main keeps the bold; the renderer's `WikiLink.toExternalHTML` does not
    // emit the marks it carries in props, and a cell serializes through it.
    name: 'marked wiki link in a table cell',
    markdown: tableOf(['a', 'b'], ['**[[A]]**', date(dateMentionData())]),
    pending: { renderer: 2365 }
  },
  {
    name: 'mention and date tokens in list items',
    markdown: `- ${mention('https://example.com/plain')}\n- ${date(dateMentionData())}`
  },
  {
    name: 'mention and date tokens in a toggle body',
    markdown: serializeToggleBlock(
      'Summary',
      `${mention('https://example.com/plain')} and ${date(dateMentionData())}`
    )
  },
  {
    name: 'wiki link, hash tag and mention in a sentence',
    markdown: `See [[Roadmap]] and #tag and ${mention('https://x.com')} inline.`
  },
  {
    name: 'callout inside a toggle body',
    markdown: serializeToggleBlock('Summary', serializeCalloutBlock('warning', 'Inside'))
  }
]

/**
 * A block indented under a list item: the bytes main writes today. Neither
 * pipeline reads them back as the same tree — the nesting markers are dropped
 * and the block lands at the top level — and the renderer does not write them
 * at all for most types. Identical on BlockNote 0.47.1 and 0.54.2, so this is
 * not upgrade fallout; it is pinned here so the fix has a target (#2365).
 */
function nestedUnderBullet(child: string): string {
  return [
    '- parent',
    '<!-- memry:block-nesting-level=1 -->',
    child,
    '<!-- memry:block-nesting-level=0 -->'
  ].join('\n\n')
}

const nestedUnderListCases: RoundtripCase[] = [
  {
    name: 'callout nested under a list item',
    markdown: nestedUnderBullet(serializeCalloutBlock('info', 'Heads up')),
    pending: { renderer: 2365, main: 2365 }
  },
  {
    name: 'task block nested under a list item',
    markdown: nestedUnderBullet('- [ ] a task {task:t1}'),
    pending: { renderer: 2365, main: 2365 }
  },
  {
    name: 'file marker nested under a list item',
    markdown: nestedUnderBullet(
      '<!-- file:{"url":"memry-file://local/v/a/x.pdf","name":"x.pdf","size":1234,"mimeType":"application/pdf"} -->'
    ),
    pending: { renderer: 2365, main: 2365 }
  },
  {
    name: 'youtube embed marker nested under a list item',
    markdown: nestedUnderBullet('![embed](https://www.youtube.com/watch?v=dQw4w9WgXcQ)'),
    pending: { renderer: 2365, main: 2365 }
  },
  {
    name: 'bookmark marker nested under a list item',
    markdown: nestedUnderBullet('![bookmark](https://example.com/a)'),
    pending: { renderer: 2365, main: 2365 }
  }
]

const blockMarkerCases: RoundtripCase[] = [
  {
    name: 'youtube embed marker',
    markdown: '![embed](https://www.youtube.com/watch?v=dQw4w9WgXcQ)'
  },
  { name: 'bookmark marker', markdown: '![bookmark](https://example.com/a)' },
  {
    name: 'file marker',
    markdown:
      '<!-- file:{"url":"memry-file://local/v/a/x.pdf","name":"x.pdf","size":1234,"mimeType":"application/pdf"} -->'
  },
  { name: 'task block line', markdown: '- [ ] a task {task:t1}' },
  { name: 'centred paragraph', markdown: '<!-- align:center -->\nCentred' },
  { name: 'right-aligned heading', markdown: '<!-- align:right -->\n## Title' },
  { name: 'justified paragraph', markdown: '<!-- align:justify -->\nJustified' },
  {
    name: 'centred callout',
    markdown: `<!-- align:center -->\n${serializeCalloutBlock('info', 'Heads up')}`
  },
  {
    name: 'coloured callout',
    markdown: `<!-- colors:{"textColor":"red"} -->\n${serializeCalloutBlock('warning', 'Careful')}`
  },
  {
    name: 'table with a dragged column width',
    markdown: `<!-- table-layout:{"columnWidths":[120,null]} -->\n${tableOf(['Name', 'Status'], ['Ship', 'Done'])}`
  },
  {
    // The two table markers in on-disk order; a table can carry both and the
    // second pass has to reproduce that order exactly.
    name: 'table with cell colours and a dragged column width',
    markdown: [
      '<!-- table-colors:{"0:0":{"textColor":"red"}} -->',
      '<!-- table-layout:{"columnWidths":[120,null]} -->',
      tableOf(['Name', 'Status'], ['Ship', 'Done'])
    ].join('\n')
  }
]

/**
 * A Mermaid diagram is a ```` ```mermaid ```` fence on disk (#1870), and the
 * fence is the whole compatibility story: it is what Obsidian, GitHub and
 * GitLab already render, and it is what a Memry build WITHOUT the block reads
 * back as a plain code block rather than as nothing at all.
 *
 * So what these cases pin is that the block is invisible to the file. The
 * source's own indentation is why there is more than one of them: BlockNote's
 * markdown parser indents the HTML it builds, and the repair that strips that
 * artifact out of prose had to learn that a diagram's bytes are literal —
 * without it `graph TD\n    A[Start]` came back one space short, and the note
 * was rewritten a space shorter on every open.
 */
const diagramCases: RoundtripCase[] = [
  {
    name: 'mermaid fence',
    markdown: '```mermaid\ngraph TD\n    A[Start] --> B[Stop]\n```'
  },
  {
    // Deeper and uneven indentation, which is where a per-line strip shows up
    // as a diagram that walks left one space at a time.
    name: 'mermaid fence with nested indentation',
    markdown:
      '```mermaid\nsequenceDiagram\n    Alice->>John: Hello\n        Note right of John: thinking\n    John-->>Alice: Great\n```'
  },
  {
    // What `/mermaid` leaves behind when the author clears the starter source.
    name: 'empty mermaid fence',
    markdown: '```mermaid\n```'
  },
  {
    // Two trailing spaces are a hard break in prose and two trailing spaces in
    // a diagram, so the mask has to give the spelling back here exactly as it
    // does inside a code fence.
    name: 'mermaid fence with trailing spaces',
    markdown: '```mermaid\ngraph TD  \n  A --> B\n```'
  },
  {
    name: 'mermaid fence between paragraphs',
    markdown: 'Before\n\n```mermaid\ngraph LR\n  A --> B\n```\n\nAfter'
  },
  {
    // The neighbour that must NOT be claimed. `runsBefore: ['codeBlock']` lets
    // the diagram's parse rule go first, so a fence tagged anything else has
    // to come back a code block with its language intact.
    name: 'javascript fence is not claimed by the diagram block',
    markdown: '```js\nconst a = 1\n```'
  }
]

/**
 * A whiteboard is `![whiteboard](memry://canvas/<id>)` on disk, claimed only
 * as a whole line pointing at a canvas id. What the cases around the plain
 * marker pin is the claim's edges: an image with the same alt text and an
 * ordinary URL is somebody's image, and a marker quoted in a code block is
 * documentation, not a board.
 */
const WHITEBOARD_ID = 'V1StGXR8_Z5jdHi6B-myT'

const whiteboardCases: RoundtripCase[] = [
  { name: 'whiteboard marker', markdown: serializeWhiteboard(WHITEBOARD_ID) },
  {
    name: 'whiteboard between paragraphs',
    markdown: `Before\n\n${serializeWhiteboard(WHITEBOARD_ID)}\n\nAfter`
  },
  {
    name: 'whiteboard in a toggle body',
    markdown: serializeToggleBlock('Summary', serializeWhiteboard(WHITEBOARD_ID))
  },
  {
    name: 'a whiteboard alt text on a non-canvas url stays an image',
    markdown: '![whiteboard](https://example.com/board.png)'
  },
  {
    // Tagged for the reason the math fence case gives: an untagged fence is a
    // different, pre-existing gap between the two pipelines.
    name: 'a whiteboard marker inside a code block stays code',
    markdown: `\`\`\`text\n${serializeWhiteboard(WHITEBOARD_ID)}\n\`\`\``
  }
]

/**
 * Spellings Memry never writes, from files it did not author (#1915). The
 * block tree cannot tell `* One` from `- One`, so `canonical` here records
 * the house style an EDITED region comes back in. What an untouched document
 * comes back as is the author's bytes, asserted by the source-preserving layer
 * both suites run over every case in this corpus.
 */
const foreignSpellingCases: RoundtripCase[] = [
  { name: 'asterisk bullets', markdown: '* One\n* Two', canonical: '- One\n- Two' },
  { name: 'plus bullets', markdown: '+ One\n+ Two', canonical: '- One\n- Two' },
  {
    name: 'underscore emphasis and strong',
    markdown: 'This is _em_ and __strong__.',
    canonical: 'This is *em* and **strong**.'
  },
  {
    name: 'setext heading',
    markdown: 'My Title\n========\n\nBody.',
    canonical: '# My Title\n\nBody.'
  },
  { name: 'setext level-two heading', markdown: 'Sub\n---\n\nBody.', canonical: '## Sub\n\nBody.' },
  {
    name: 'dash thematic break',
    markdown: 'Above\n\n---\n\nBelow',
    canonical: 'Above\n\n***\n\nBelow'
  },
  { name: 'list glued to its paragraph', markdown: 'Text:\n- Item', canonical: 'Text:\n\n- Item' },
  { name: 'four-space nested list indent', markdown: '- a\n    - b', canonical: '- a\n  - b' },
  { name: 'trailing space after a heading', markdown: '# Title ', canonical: '# Title' },
  {
    name: 'list glued to a bold line',
    markdown: '**Bold**\n- Item',
    canonical: '**Bold**\n\n- Item'
  }
]

export const ROUNDTRIP_CASES: readonly RoundtripCase[] = [
  ...mentionCases,
  ...dateCases,
  ...calloutCases,
  ...toggleCases,
  ...mathCases,
  ...containerCases,
  ...blockMarkerCases,
  ...nestedUnderListCases,
  ...diagramCases,
  ...whiteboardCases,
  ...foreignSpellingCases
]

// ---------------------------------------------------------------------------
// Deterministic fuzz layer — no property-testing dependency in the workspace,
// so a seeded mulberry32 keeps every CI run byte-reproducible.
// ---------------------------------------------------------------------------

export function createSeededRandom(seed: number): () => number {
  let state = seed >>> 0
  return () => {
    state = (state + 0x6d2b79f5) >>> 0
    let t = state
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

function pick<T>(random: () => number, values: readonly T[]): T {
  return values[Math.floor(random() * values.length)]
}

function stringFrom(random: () => number, alphabet: readonly string[], length: number): string {
  return Array.from({ length }, () => pick(random, alphabet)).join('')
}

/** Every character class the issue names as a breaker, plus plain filler. */
const URL_ALPHABET = [
  ...'abcz019',
  '_',
  '*',
  '!',
  '~',
  "'",
  '(',
  ')',
  '%',
  '&',
  '=',
  '#',
  ' ',
  'é',
  '日'
] as const

const ANCHOR_ALPHABET = [...'abcz019', '-', '_', '?', '~', '>', '<', '&', 'ÿ', 'û'] as const

/**
 * Free text remark-stringify reproduces verbatim. Emphasis pairs (`_x_`,
 * `*x*`), backticks and link brackets are deliberately absent: remark
 * canonicalizes those in ANY paragraph, callout or not — an app-wide behavior
 * outside this suite's contract. The token alphabets above are where the
 * markdown-significant characters belong, because inside a token nothing may
 * be rewritten, ever.
 */
const INERT_TEXT_ALPHABET = [...'abcz019 .,:;?!', 'é', '日'] as const

function inertLine(random: () => number): string {
  // Runs of spaces collapse in any paragraph — accepted remark behavior, same
  // rationale as the emphasis exclusions above.
  return (
    stringFrom(random, INERT_TEXT_ALPHABET, 1 + Math.floor(random() * 20))
      .replace(/\s+/g, ' ')
      .trim() || 'x'
  )
}

function fuzzMentionMarkdown(random: () => number): string {
  const path = stringFrom(random, URL_ALPHABET, 1 + Math.floor(random() * 24))
  const url = `https://fuzz.example/${path}`
  return `Fuzz ${serializeLinkMentionToken(url)} tail.`
}

function fuzzDateMarkdown(random: () => number): string {
  const remindValues = ['none', 'at', '5m', '1h', '1d', '1w'] as const
  const data = dateMentionData({
    anchorId: stringFrom(random, ANCHOR_ALPHABET, 1 + Math.floor(random() * 16)),
    hasTime: random() > 0.5,
    dateFormat: random() > 0.5 ? 'full' : 'relative',
    remind: pick(random, remindValues)
  })
  return `Fuzz ${serializeDateMentionToken(data)} tail.`
}

function fuzzCalloutMarkdown(random: () => number): string {
  const types = ['info', 'warning', 'error', 'success'] as const
  const lines = 1 + Math.floor(random() * 3)
  const body = Array.from({ length: lines }, () => inertLine(random)).join('\n')
  return serializeCalloutBlock(pick(random, types), body)
}

/**
 * LaTeX-ish source: every character class a formula is made of, minus `$` so
 * the generator cannot write a fence line into the body it is fencing.
 */
const LATEX_ALPHABET = [...'abcxyz019', '\\', '{', '}', '^', '_', '+', '-', '=', '&', ' '] as const

function fuzzMathMarkdown(random: () => number): string {
  const line = (): string =>
    stringFrom(random, LATEX_ALPHABET, 1 + Math.floor(random() * 24)).trim() || 'x'
  const lines = Array.from({ length: 1 + Math.floor(random() * 3) }, line)
  return serializeMathBlock(lines.join('\n'))
}

function fuzzToggleMarkdown(random: () => number, depth = 0): string {
  const roll = random()
  const body =
    roll < 0.2
      ? ''
      : roll < 0.4
        ? `${inertLine(random)}\n\n${inertLine(random)}`
        : roll < 0.6
          ? `\`\`\`ts\nconst x = ${Math.floor(random() * 100)}\n\`\`\``
          : roll < 0.8 && depth === 0
            ? fuzzToggleMarkdown(random, depth + 1)
            : inertLine(random)
  return serializeToggleBlock(inertLine(random), body, null, random() < 0.5)
}

/**
 * URL characters whose encoded form is markdown-inert on current main, so the
 * mixed-document family stays green while the mention family above carries the
 * hostile alphabet (and its pending flag) alone.
 */
const SAFE_URL_ALPHABET = [...'abcz019', ' ', '(', ')', 'é', '日'] as const

function safeMentionSentence(random: () => number): string {
  const path = stringFrom(random, SAFE_URL_ALPHABET, 1 + Math.floor(random() * 12))
  return `${inertLine(random)} ${serializeLinkMentionToken(`https://fuzz.example/${path}`)} ${inertLine(random)}`
}

/**
 * Whole notes mixing every token family with paragraphs, lists and blank-line
 * gaps — the shape a real vault file has, where a bug in one block's region
 * scanner shreds its NEIGHBOR (a toggle body swallowing the callout after it,
 * a gap growing by one line per save).
 */
function fuzzMixedDocumentMarkdown(random: () => number): string {
  let previousWasList = false
  const nextPart = (): string => {
    const roll = random()
    // Two lists across one blank line are ONE list to CommonMark, so the gap
    // fuses on the way back — accepted canonicalization, not token damage;
    // the generator never produces the shape.
    if (roll < 0.15 && !previousWasList) {
      previousWasList = true
      return `- ${inertLine(random)}\n- ${inertLine(random)}`
    }
    previousWasList = false
    if (roll < 0.35) return safeMentionSentence(random)
    if (roll < 0.55)
      return `${inertLine(random)} ${serializeDateMentionToken(dateMentionData({ anchorId: stringFrom(random, ANCHOR_ALPHABET, 6) }))}`
    if (roll < 0.7) return fuzzCalloutMarkdown(random)
    if (roll < 0.85) return fuzzToggleMarkdown(random, 1)
    return inertLine(random)
  }
  const parts = Array.from({ length: 2 + Math.floor(random() * 4) }, nextPart)
  // Joined on a gap, not a plain paragraph break: an extra blank line next to
  // a toggle or a callout is exactly what #1877 collapsed, so the generator
  // now puts one at every seam and the family fails if it ever collapses again.
  return parts.join('\n\n\n')
}

/**
 * The read-direction corpus (N102), for the `note-blocks` vector class.
 *
 * **Why it is here and not in `@memry/contracts`.** A vector has to come out
 * of a production code path, and the production path that turns blocks into
 * `prosemirror` bytes is BlockNote's own — which lives in this package's
 * dependency, not in contracts. `conformance-ydoc.ts` beside this file does
 * the authoring; contracts imports the result, the way it already imports
 * `ROUNDTRIP_CASES`.
 *
 * **What it has to cover, and why the count is asserted.** FR-040's registry
 * is 18 blocks, 8 inline types and 7 styles
 * (`registry-manifest.json`, chapter 12 §12.9). `extract_blocks` had no vector
 * class at all, and the self-consistency test it did have compared two walks
 * of one port against each other — which agree whether or not either is
 * right. That is precisely how dropping `divider` went unnoticed. So the
 * corpus is checked against the manifest rather than eyeballed: a type nobody
 * wrote a case for is a failing test.
 */
export interface NoteBlockCase {
  name: string
  /** What this case is here to catch, in one sentence. */
  pins: string
  /**
   * BlockNote blocks, in the shape `blocksToYXmlFragment` takes. Loosely
   * typed on purpose: pinning the precise generic here would make every case
   * a type-level puzzle, and the schema validates them at authoring time.
   */
  blocks: unknown[]
}

/** A paragraph carrying one styled run, for the style cases. */
function styled(text: string, styles: Record<string, unknown>): NoteBlockCase['blocks'] {
  return [{ type: 'paragraph', content: [{ type: 'text', text, styles }] }]
}

export const NOTE_BLOCK_CASES: readonly NoteBlockCase[] = [
  {
    name: 'paragraph',
    pins: 'the simplest block, and the one every unknown type falls back to',
    blocks: [{ type: 'paragraph', content: 'One plain paragraph.' }]
  },
  {
    name: 'headings at every level',
    pins: 'all six levels survive as a `level` prop; the shell renders six, not three',
    blocks: [1, 2, 3, 4, 5, 6].map((level) => ({
      type: 'heading',
      props: { level },
      content: `Level ${level}`
    }))
  },
  {
    name: 'bulletListItem',
    pins: 'a bullet list, including a nested child that arrives one depth deeper',
    blocks: [
      {
        type: 'bulletListItem',
        content: 'Outer',
        children: [{ type: 'bulletListItem', content: 'Inner' }]
      },
      { type: 'bulletListItem', content: 'Second' }
    ]
  },
  {
    name: 'numberedListItem',
    pins: 'three items that a shell must number 1, 2, 3 — the core emits no marker',
    blocks: ['First', 'Second', 'Third'].map((content) => ({
      type: 'numberedListItem',
      content
    }))
  },
  {
    name: 'checkListItem',
    pins: 'the `checked` prop, both ways',
    blocks: [
      { type: 'checkListItem', props: { checked: true }, content: 'Done' },
      { type: 'checkListItem', props: { checked: false }, content: 'Not done' }
    ]
  },
  {
    name: 'divider',
    pins: 'THE REGRESSION THIS CLASS EXISTS FOR: a divider must reach the shell as a block, between two paragraphs that prove it did not swallow them',
    blocks: [
      { type: 'paragraph', content: 'Above' },
      { type: 'divider' },
      { type: 'paragraph', content: 'Below' }
    ]
  },
  {
    name: 'quote',
    pins: 'a quote is a block, not a paragraph with a marker',
    blocks: [{ type: 'quote', content: 'Someone said this.' }]
  },
  {
    name: 'callout',
    pins: 'the callout `type` survives, which `extract_text` drops',
    blocks: [
      { type: 'callout', props: { type: 'warning' }, content: 'Mind the gap.' },
      { type: 'callout', props: { type: 'info' }, content: 'For your information.' }
    ]
  },
  {
    name: 'codeBlock',
    pins: 'the language survives and the newline inside the code is not a block break',
    blocks: [
      {
        type: 'codeBlock',
        props: { language: 'typescript' },
        content: 'const x = 1\nconsole.log(x)'
      }
    ]
  },
  {
    name: 'toggleListItem',
    pins: 'the open state is a prop and the body arrives as a child one depth deeper',
    blocks: [
      {
        type: 'toggleListItem',
        content: 'Summary line',
        children: [{ type: 'paragraph', content: 'Hidden body.' }]
      }
    ]
  },
  {
    name: 'taskBlock',
    pins: 'the Memry task block is `content: none` — its text is the `title` PROP, so a reader that only walks inline content shows an empty row',
    blocks: [
      {
        type: 'taskBlock',
        props: { taskId: 't1', title: 'A task in a note', checked: false }
      }
    ]
  },
  {
    name: 'image',
    pins: 'a picture block: the url, name and caption cross as props, the bytes do not',
    blocks: [
      {
        type: 'image',
        props: { url: 'attachment://a1.png', name: 'a1.png', caption: 'A picture' }
      }
    ]
  },
  {
    name: 'video',
    pins: 'metadata only, and the block must not fall through to an empty paragraph',
    blocks: [{ type: 'video', props: { url: 'attachment://clip.mp4', name: 'clip.mp4' } }]
  },
  {
    name: 'audio',
    pins: 'same, for audio',
    blocks: [{ type: 'audio', props: { url: 'attachment://note.m4a', name: 'note.m4a' } }]
  },
  {
    name: 'file',
    pins: 'a file block carries its own name and size and needs no bytes to render a row',
    blocks: [{ type: 'file', props: { url: 'attachment://spec.pdf', name: 'spec.pdf' } }]
  },
  {
    name: 'bookmark',
    pins: 'a bookmark card is entirely props; nothing is fetched to draw it',
    blocks: [
      {
        type: 'bookmark',
        props: { url: 'https://example.com/a', title: 'Example', description: 'A site' }
      }
    ]
  },
  {
    name: 'youtubeEmbed',
    pins: 'the video url survives so a shell can offer to open it',
    blocks: [
      { type: 'youtubeEmbed', props: { videoUrl: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ' } }
    ]
  },
  {
    name: 'diagram',
    pins: 'a Mermaid diagram is plain-content source text, newlines and all; the rendering is never in the document',
    blocks: [{ type: 'diagram', content: 'graph TD\n  A[Start] --> B{Ship?}' }]
  },
  {
    name: 'mathBlock',
    pins: 'a math block is `content: none` — the LaTeX is the `latex` PROP, so a reader that only walks inline content shows an empty row',
    blocks: [{ type: 'mathBlock', props: { latex: '\\int_0^1 x^2 \\, dx = \\frac{1}{3}' } }]
  },
  {
    name: 'whiteboard',
    pins: 'a whiteboard is `content: none` and holds only the `canvasId` PROP — the drawing lives in its own canvas file, never in the note',
    blocks: [{ type: 'whiteboard', props: { canvasId: WHITEBOARD_ID } }]
  },
  {
    name: 'table',
    pins: 'THE SECOND REGRESSION: a mixed header/cell table with a set colwidth and a coloured cell, which a flat block list cannot express',
    blocks: [
      {
        type: 'table',
        content: {
          type: 'tableContent',
          columnWidths: [180, undefined],
          headerRows: 1,
          rows: [
            {
              cells: [
                {
                  type: 'tableCell',
                  content: [{ type: 'text', text: 'Name', styles: {} }],
                  props: { colspan: 1, rowspan: 1, textAlignment: 'left' }
                },
                {
                  type: 'tableCell',
                  content: [{ type: 'text', text: 'Value', styles: {} }],
                  props: { colspan: 1, rowspan: 1, textAlignment: 'left' }
                }
              ]
            },
            {
              cells: [
                {
                  type: 'tableCell',
                  content: [{ type: 'text', text: 'alpha', styles: {} }],
                  props: { colspan: 1, rowspan: 1, textAlignment: 'left' }
                },
                {
                  type: 'tableCell',
                  content: [{ type: 'text', text: '1', styles: {} }],
                  props: {
                    colspan: 1,
                    rowspan: 1,
                    backgroundColor: 'yellow',
                    textAlignment: 'center'
                  }
                }
              ]
            }
          ]
        }
      }
    ]
  },
  {
    name: 'inline: link',
    pins: 'a link carries its href as an attribute, not as text',
    blocks: [
      {
        type: 'paragraph',
        content: [
          { type: 'text', text: 'see ', styles: {} },
          { type: 'link', href: 'https://example.com/a', content: 'the docs' }
        ]
      }
    ]
  },
  {
    name: 'inline: wikiLink',
    pins: 'a wiki link points at a TITLE, and its alias is a separate prop',
    blocks: [
      {
        type: 'paragraph',
        content: [
          { type: 'text', text: 'see ', styles: {} },
          { type: 'wikiLink', props: { target: 'Dune Messiah', alias: 'the sequel' } }
        ]
      }
    ]
  },
  {
    name: 'inline: hashTag',
    pins: 'a tag is an inline node, not a `#` a shell has to parse back out of text',
    blocks: [
      {
        type: 'paragraph',
        content: [
          { type: 'text', text: 'filed under ', styles: {} },
          { type: 'hashTag', props: { tag: 'reading' } }
        ]
      }
    ]
  },
  {
    name: 'inline: dateMention',
    pins: 'the whole date payload survives, which Phase G needs and `extract_text` drops',
    blocks: [
      {
        type: 'paragraph',
        content: [
          { type: 'text', text: 'due ', styles: {} },
          {
            type: 'dateMention',
            props: {
              anchorId: 'a1',
              dateISO: '2026-08-14T09:00:00.000Z',
              display: 'date',
              remindMe: false
            }
          }
        ]
      }
    ]
  },
  {
    name: 'inline: linkMention',
    pins: 'the mention url, which encodes seven characters beyond encodeURIComponent',
    blocks: [
      {
        type: 'paragraph',
        content: [
          { type: 'text', text: 'via ', styles: {} },
          { type: 'linkMention', props: { url: "https://example.com/x_(y)*z!~'" } }
        ]
      }
    ]
  },
  {
    name: 'inline: inlineImage and inlineCheckbox in a table cell',
    pins: 'both inline types exist ONLY inside a table cell (§12.7.1), so this is the only shape that can carry them',
    blocks: [
      {
        type: 'table',
        content: {
          type: 'tableContent',
          rows: [
            {
              cells: [
                {
                  type: 'tableCell',
                  content: [
                    { type: 'inlineCheckbox', props: { checked: true } },
                    { type: 'text', text: ' ', styles: {} },
                    { type: 'inlineImage', props: { src: 'attachment://i.png', alt: 'i' } }
                  ],
                  props: { colspan: 1, rowspan: 1 }
                }
              ]
            }
          ]
        }
      }
    ]
  },
  {
    name: 'styles: the five boolean marks',
    pins: 'bold, italic, underline, strike and code all survive as marks on the run',
    blocks: [
      {
        type: 'paragraph',
        content: [
          { type: 'text', text: 'bold', styles: { bold: true } },
          { type: 'text', text: ' italic', styles: { italic: true } },
          { type: 'text', text: ' underline', styles: { underline: true } },
          { type: 'text', text: ' strike', styles: { strike: true } },
          { type: 'text', text: ' code', styles: { code: true } }
        ]
      }
    ]
  },
  {
    name: 'styles: textColor and backgroundColor',
    pins: 'THE THIRD REGRESSION: a colour mark must carry its VALUE, or red and blue arrive identical',
    blocks: styled('red on yellow', { textColor: 'red', backgroundColor: 'yellow' })
  },
  {
    name: 'styles: two colours in one paragraph',
    pins: 'two runs of the same mark with different values, which a name-only reader collapses',
    blocks: [
      {
        type: 'paragraph',
        content: [
          { type: 'text', text: 'red', styles: { textColor: 'red' } },
          { type: 'text', text: ' and ', styles: {} },
          { type: 'text', text: 'blue', styles: { textColor: 'blue' } }
        ]
      }
    ]
  },
  {
    name: 'block props: alignment and colours',
    pins: 'block-level textAlignment, textColor and backgroundColor, which `props_of` returned and nothing read',
    blocks: [
      {
        type: 'paragraph',
        props: { textAlignment: 'center', textColor: 'blue', backgroundColor: 'gray' },
        content: 'Centred and coloured.'
      }
    ]
  },
  {
    name: 'an empty document',
    pins: 'no blocks at all is an empty list, never one empty paragraph',
    blocks: []
  },
  {
    name: 'a non-ASCII body',
    pins: 'the walk is byte-transparent over UTF-8, including astral code points',
    blocks: [{ type: 'paragraph', content: 'Grüße, 世界 — «citation» 🙂' }]
  }
]

/**
 * The write-direction corpus (N107), for the `block-edit` vector class.
 *
 * **What it compares, and why not update bytes.** A write case has to hold a
 * document `yrs` produced against one `yjs` produced, and update bytes cannot
 * do that: an update encodes `clientID` and per-client clocks, and struct
 * ordering, origin ids and run-length packing are free choices an
 * implementation may make differently while still converging. Two different
 * updates that converge are *both correct*. So a case records a base
 * document, one operation, and the **expected resulting document**, and a port
 * applies the operation and re-renders through the canonical fragment form.
 *
 * **Both documents are authored through BlockNote.** That makes the assertion
 * "the writer produces the document BlockNote would have produced", which is
 * exactly what §12.5.0 demands: y-prosemirror answers a node its schema cannot
 * construct by DELETING the element, silently, and the next desktop to open
 * the note renders it without the block. A writer held only to its own idea of
 * the shape cannot catch that.
 *
 * **Ids are explicit on every block**, because an operation that inserts or
 * deletes one shifts every positional id after it, and the base and the
 * expected result have to name the same blocks.
 */
export interface BlockEditCase {
  name: string
  pins: string
  /** The document before the edit. */
  base: unknown[]
  /** The operation, in the shape the core's `BlockEdit` enum takes. */
  op: BlockEditOp
  /** The document the edit must produce. */
  expected: unknown[]
  /**
   * Set when the case FAILS against the current writer because the fix it
   * asserts has not landed yet. The Rust harness runs these inverted, so the
   * moment the writer is fixed the case turns red and forces the flag's
   * removal. Remove the flag, never the case — the same convention
   * `ROUNDTRIP_CASES` uses.
   */
  pending?: { reason: string; task: string }
}

export type BlockEditOp =
  | { kind: 'setText'; blockId: string; text: string }
  | { kind: 'setProp'; blockId: string; name: string; value: string }
  | { kind: 'insertParagraph'; afterBlockId?: string; text: string; newBlockId: string }
  | { kind: 'setCellText'; tableId: string; row: number; column: number; text: string }
  | {
      kind: 'setCellProp'
      tableId: string
      row: number
      column: number
      name: string
      value: string
    }
  | { kind: 'delete'; blockId: string }

/** Two paragraphs, the base most cases start from. */
const TWO_PARAGRAPHS: unknown[] = [
  { id: 'p1', type: 'paragraph', content: 'First paragraph.' },
  { id: 'p2', type: 'paragraph', content: 'Second paragraph.' }
]

const EDITABLE_TABLE = [
  {
    id: 'tbl1',
    type: 'table',
    content: {
      type: 'tableContent',
      columnWidths: [180, undefined],
      headerRows: 1,
      rows: [
        {
          cells: [
            {
              type: 'tableCell',
              content: [{ type: 'text', text: 'Name', styles: {} }],
              props: { colspan: 1, rowspan: 1, textAlignment: 'left' }
            },
            {
              type: 'tableCell',
              content: [{ type: 'text', text: 'Value', styles: {} }],
              props: { colspan: 1, rowspan: 1, textAlignment: 'left' }
            }
          ]
        },
        {
          cells: [
            {
              type: 'tableCell',
              content: [{ type: 'text', text: 'alpha', styles: {} }],
              props: { colspan: 1, rowspan: 1, textAlignment: 'left' }
            },
            {
              type: 'tableCell',
              content: [{ type: 'text', text: '1', styles: {} }],
              props: { colspan: 1, rowspan: 1, textAlignment: 'left' }
            }
          ]
        }
      ]
    }
  }
]

/** The same table with one body cell rewritten. */
const TABLE_WITH_EDITED_CELL = [
  {
    id: 'tbl1',
    type: 'table',
    content: {
      type: 'tableContent',
      columnWidths: [180, undefined],
      headerRows: 1,
      rows: [
        {
          cells: [
            {
              type: 'tableCell',
              content: [{ type: 'text', text: 'Name', styles: {} }],
              props: { colspan: 1, rowspan: 1, textAlignment: 'left' }
            },
            {
              type: 'tableCell',
              content: [{ type: 'text', text: 'Value', styles: {} }],
              props: { colspan: 1, rowspan: 1, textAlignment: 'left' }
            }
          ]
        },
        {
          cells: [
            {
              type: 'tableCell',
              content: [{ type: 'text', text: 'alpha', styles: {} }],
              props: { colspan: 1, rowspan: 1, textAlignment: 'left' }
            },
            {
              type: 'tableCell',
              content: [{ type: 'text', text: '42', styles: {} }],
              props: { colspan: 1, rowspan: 1, textAlignment: 'left' }
            }
          ]
        }
      ]
    }
  }
]

/** The same table with one body cell given a background colour. */
const TABLE_WITH_COLOURED_CELL = [
  {
    id: 'tbl1',
    type: 'table',
    content: {
      type: 'tableContent',
      columnWidths: [180, undefined],
      headerRows: 1,
      rows: [
        {
          cells: [
            {
              type: 'tableCell',
              content: [{ type: 'text', text: 'Name', styles: {} }],
              props: { colspan: 1, rowspan: 1, textAlignment: 'left' }
            },
            {
              type: 'tableCell',
              content: [{ type: 'text', text: 'Value', styles: {} }],
              props: { colspan: 1, rowspan: 1, textAlignment: 'left' }
            }
          ]
        },
        {
          cells: [
            {
              type: 'tableCell',
              content: [{ type: 'text', text: 'alpha', styles: {} }],
              props: { colspan: 1, rowspan: 1, textAlignment: 'left' }
            },
            {
              type: 'tableCell',
              content: [{ type: 'text', text: '1', styles: {} }],
              props: {
                colspan: 1,
                rowspan: 1,
                backgroundColor: 'yellow',
                textAlignment: 'left'
              }
            }
          ]
        }
      ]
    }
  }
]

export const BLOCK_EDIT_CASES: readonly BlockEditCase[] = [
  {
    name: 'setText replaces one block and leaves its sibling alone',
    pins: 'the edit is scoped to the block it names; FR-041 rests on the untouched sibling',
    base: TWO_PARAGRAPHS,
    op: { kind: 'setText', blockId: 'p1', text: 'Rewritten.' },
    expected: [
      { id: 'p1', type: 'paragraph', content: 'Rewritten.' },
      { id: 'p2', type: 'paragraph', content: 'Second paragraph.' }
    ]
  },
  {
    name: 'setText on an empty string empties the block without removing it',
    pins: 'an emptied paragraph is still a paragraph, not a deleted block',
    base: TWO_PARAGRAPHS,
    op: { kind: 'setText', blockId: 'p2', text: '' },
    expected: [
      { id: 'p1', type: 'paragraph', content: 'First paragraph.' },
      { id: 'p2', type: 'paragraph' }
    ]
  },
  {
    name: 'setText keeps a nested child, which lives in its own block',
    pins: 'a list item’s children are their own blocks with their own ids and must survive a text replace',
    base: [
      {
        id: 'l1',
        type: 'bulletListItem',
        content: 'Outer',
        children: [{ id: 'l2', type: 'bulletListItem', content: 'Inner' }]
      }
    ],
    op: { kind: 'setText', blockId: 'l1', text: 'Outer rewritten' },
    expected: [
      {
        id: 'l1',
        type: 'bulletListItem',
        content: 'Outer rewritten',
        children: [{ id: 'l2', type: 'bulletListItem', content: 'Inner' }]
      }
    ]
  },
  {
    name: 'setProp ticks a check list item',
    pins: 'a prop crosses as the string the document stores; the core does not know which props are numbers',
    base: [{ id: 'c1', type: 'checkListItem', props: { checked: false }, content: 'A task' }],
    op: { kind: 'setProp', blockId: 'c1', name: 'checked', value: 'true' },
    expected: [{ id: 'c1', type: 'checkListItem', props: { checked: true }, content: 'A task' }]
  },
  {
    name: 'setProp changes a callout type',
    pins: 'the callout type is a prop rather than a separate block type',
    base: [{ id: 'k1', type: 'callout', props: { type: 'info' }, content: 'Mind the gap.' }],
    op: { kind: 'setProp', blockId: 'k1', name: 'type', value: 'warning' },
    expected: [{ id: 'k1', type: 'callout', props: { type: 'warning' }, content: 'Mind the gap.' }]
  },
  {
    name: 'setProp changes a heading level',
    pins: 'all six levels are reachable by a prop edit, which is what the shell now renders',
    base: [{ id: 'h1', type: 'heading', props: { level: 2 }, content: 'A heading' }],
    op: { kind: 'setProp', blockId: 'h1', name: 'level', value: '5' },
    expected: [{ id: 'h1', type: 'heading', props: { level: 5 }, content: 'A heading' }]
  },
  {
    name: 'delete removes one block and nothing else',
    pins: 'the surviving sibling is byte-identical, which is the whole of FR-041 for a delete',
    base: [
      { id: 'p1', type: 'paragraph', content: 'First paragraph.' },
      { id: 'p2', type: 'paragraph', content: 'Second paragraph.' },
      { id: 'p3', type: 'paragraph', content: 'Third paragraph.' }
    ],
    op: { kind: 'delete', blockId: 'p2' },
    expected: [
      { id: 'p1', type: 'paragraph', content: 'First paragraph.' },
      { id: 'p3', type: 'paragraph', content: 'Third paragraph.' }
    ]
  },
  {
    name: 'delete takes a block’s children with it',
    pins: 'children live inside the container, and leaving them behind would reparent a list’s items to the body',
    base: [
      {
        id: 'l1',
        type: 'bulletListItem',
        content: 'Outer',
        children: [{ id: 'l2', type: 'bulletListItem', content: 'Inner' }]
      },
      { id: 'p1', type: 'paragraph', content: 'After.' }
    ],
    op: { kind: 'delete', blockId: 'l1' },
    expected: [{ id: 'p1', type: 'paragraph', content: 'After.' }]
  },
  {
    name: 'insertParagraph after a block',
    pins: 'THE §12.5.0 CASE: the writer must produce the node shape BlockNote produces, defaults included, or a peer cannot construct it',
    base: TWO_PARAGRAPHS,
    op: { kind: 'insertParagraph', afterBlockId: 'p1', text: 'Inserted.', newBlockId: 'p1a' },
    expected: [
      { id: 'p1', type: 'paragraph', content: 'First paragraph.' },
      { id: 'p1a', type: 'paragraph', content: 'Inserted.' },
      { id: 'p2', type: 'paragraph', content: 'Second paragraph.' }
    ]
  },
  {
    name: 'insertParagraph at the end of the body',
    pins: 'an absent `after` appends, and the writer must locate the existing blockGroup rather than adding a second top-level child',
    base: TWO_PARAGRAPHS,
    op: { kind: 'insertParagraph', text: 'Appended.', newBlockId: 'p3' },
    expected: [
      { id: 'p1', type: 'paragraph', content: 'First paragraph.' },
      { id: 'p2', type: 'paragraph', content: 'Second paragraph.' },
      { id: 'p3', type: 'paragraph', content: 'Appended.' }
    ]
  },
  {
    name: 'setCellText rewrites one cell and leaves the rest of the table alone',
    pins: 'a cell is addressed by table id plus row and column, because a cell carries no blockContainer id of its own (Q1)',
    base: EDITABLE_TABLE,
    op: { kind: 'setCellText', tableId: 'tbl1', row: 1, column: 1, text: '42' },
    expected: TABLE_WITH_EDITED_CELL
  },
  {
    name: 'setCellProp colours one cell',
    pins: 'a cell colour is what desktop regenerates the table-colors marker from, so it has to land on the cell rather than on the table',
    base: EDITABLE_TABLE,
    op: {
      kind: 'setCellProp',
      tableId: 'tbl1',
      row: 1,
      column: 1,
      name: 'backgroundColor',
      value: 'yellow'
    },
    expected: TABLE_WITH_COLOURED_CELL
  }
]

export interface FuzzFamily {
  name: string
  generate: (random: () => number) => string
  pending?: { renderer?: number; main?: number }
}

export const FUZZ_FAMILIES: readonly FuzzFamily[] = [
  { name: 'link mention urls', generate: fuzzMentionMarkdown },
  { name: 'date pill payloads', generate: fuzzDateMarkdown },
  { name: 'callout bodies', generate: fuzzCalloutMarkdown },
  // Nothing inside a `$$` fence may be escaped, and every character above is
  // one remark escapes in a paragraph.
  { name: 'math sources', generate: fuzzMathMarkdown },
  { name: 'toggle summaries and bodies', generate: (random) => fuzzToggleMarkdown(random) },
  {
    name: 'mixed documents',
    generate: fuzzMixedDocumentMarkdown,
    // The gap join reaches a callout's edge too, and the renderer's
    // blockquote splitter still trims those (#1892). Main is already green.
    pending: { renderer: 1892 }
  }
]
