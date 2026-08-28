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
 * asserts ships in a sibling of epic #1843. The suites run those with
 * `it.fails`, so the moment the sibling lands the inverted expectation turns
 * red and forces the flag's removal. Remove the flag, never the case.
 */

import { serializeLinkMentionToken } from './inline/link-mention'
import { serializeCalloutBlock, serializeToggleBlock } from './blocks/markdown'
import { serializeDateMentionToken, type DateMentionData } from '@memry/shared/date-mention'

export interface RoundtripCase {
  name: string
  /** Canonical on-disk bytes: round-tripping them must be identity. */
  markdown: string
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
    // #1875 declines blank-`>`-line shapes from the callout claim; the quote
    // path then collapses the blank line — generic blockquote behavior (#1881).
    name: 'callout with a multi-paragraph body',
    markdown: '> [!info]\n> One\n>\n> Two',
    pending: { renderer: 1881, main: 1881 }
  },
  {
    name: 'nested foreign callouts pass through untouched',
    markdown:
      '> [!note] Outer callout\n> Outer body text\n>\n> > [!warning] Inner callout\n> > Inner body text',
    pending: { renderer: 1881, main: 1881 }
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
    markdown: '<details data-memry-toggle>\n<summary>Unterminated</summary>\n\nBody',
    pending: { renderer: 1883, main: 1883 }
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
    markdown: `Before\n\n\n${serializeToggleBlock('Summary', 'Body line')}\n\n\nAfter`,
    pending: { renderer: 1877, main: 1877 }
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
    // The rich linkMention render is what a renderer-side cell serializes
    // through, rewriting the token as a markdown link — #1865's class, second
    // instance (the wiki-link case below is the first).
    name: 'mention and date tokens in table cells',
    markdown: tableOf(['a', 'b'], [mention('https://example.com/plain'), date(dateMentionData())]),
    pending: { renderer: 1865 }
  },
  {
    // The renderer's rich wikiLink render is what a table cell serializes
    // through, and it emits display text — the marker never comes back (#1865).
    name: 'wiki link and hash tag in table cells',
    markdown: tableOf(['a', 'b'], ['[[Roadmap]]', '#work']),
    pending: { renderer: 1865 }
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
  { name: 'task block line', markdown: '- [ ] a task {task:t1}' }
]

export const ROUNDTRIP_CASES: readonly RoundtripCase[] = [
  ...mentionCases,
  ...dateCases,
  ...calloutCases,
  ...toggleCases,
  ...containerCases,
  ...blockMarkerCases
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
  // A '\n\n\n' join would trip #1877 (gaps adjacent to toggles collapse);
  // the static corpus case pins that bug, so this family stays green to keep
  // catching everything else.
  return parts.join('\n\n')
}

export interface FuzzFamily {
  name: string
  generate: (random: () => number) => string
  pending?: { renderer?: number; main?: number }
}

export const FUZZ_FAMILIES: readonly FuzzFamily[] = [
  { name: 'link mention urls', generate: fuzzMentionMarkdown },
  { name: 'date pill payloads', generate: fuzzDateMarkdown },
  { name: 'callout bodies', generate: fuzzCalloutMarkdown },
  { name: 'toggle summaries and bodies', generate: (random) => fuzzToggleMarkdown(random) },
  { name: 'mixed documents', generate: fuzzMixedDocumentMarkdown }
]
