/**
 * More inputs for the `markdown-seed.json` class, in
 * [`MARKDOWN_SEED_CASES`](./markdown-seed-cases.ts): `((date:…))` and
 * `((mention:…))` tokens, which the seed promotes to `dateMention` and
 * `linkMention` nodes (chapter 12 §12.1.1.1, §12.1.1.2) except inside a styled
 * run or a code block, where they stay text.
 */

import { serializeLinkMentionToken } from '@memry/editor-schema/inline'
import {
  serializeDateMentionToken,
  type DateMentionData
} from '../../../shared/src/date-mention.ts'

function dateData(overrides: Partial<DateMentionData> = {}): DateMentionData {
  return {
    anchorId: 'dm_a1',
    dateISO: '2099-06-15T09:00:00.000Z',
    hasTime: true,
    dateFormat: 'relative',
    remind: 'none',
    timeFormat: 'system',
    ...overrides
  }
}

const date = (overrides: Partial<DateMentionData> = {}): string =>
  serializeDateMentionToken(dateData(overrides))

/** A token over any JSON payload, in the writer's alphabet; for payloads no writer emits. */
const rawDate = (payload: unknown): string =>
  `((date:${btoa(JSON.stringify(payload)).replace(/\+/g, ',').replace(/\//g, ';').replace(/=+$/, '')}))`

const mention = serializeLinkMentionToken

export const MARKDOWN_SEED_MENTION_CASES: ReadonlyArray<{
  name: string
  markdown: string
  pins: string
}> = [
  {
    name: 'date mention: in body text',
    markdown: `Due ${date()} today.`,
    pins: 'a dateMention node between two text runs, every prop set from the token'
  },
  {
    name: 'date mention: two tokens in one line',
    markdown: `${date()} and ${date({ anchorId: 'dm_b2', hasTime: false })}`,
    pins: 'two dateMention nodes in one paragraph, each with its own props'
  },
  {
    name: 'date mention: with a reminder',
    markdown: `Call ${date({ remind: '1d', hasTime: false, dateFormat: 'full', timeFormat: '24h' })}`,
    pins: 'remind, dateFormat and timeFormat are carried from the token'
  },
  {
    name: 'date mention: in bold stays text',
    markdown: `A **${date()}** b.`,
    pins: 'a token in a styled run stays text in that run (#4652)'
  },
  {
    name: 'date mention: in inline code stays text',
    markdown: `A \`${date()}\` b.`,
    pins: 'a token in a code span stays code text'
  },
  {
    name: 'date mention: in a fenced code block stays text',
    markdown: `\`\`\`\n${date()}\n\`\`\``,
    pins: "a code block's text is literal"
  },
  {
    name: 'date mention: in a table cell',
    markdown: `| a | b |\n| - | - |\n| ${date()} | x |`,
    pins: 'a token in a table cell is promoted'
  },
  {
    name: 'date mention: in a list item',
    markdown: `- call ${date()}\n- other`,
    pins: 'a token in a bullet item is promoted'
  },
  {
    name: 'date mention: in a heading',
    markdown: `## Plan ${date()}`,
    pins: 'a token in a heading is promoted'
  },
  {
    name: 'date mention: a legacy token only salvage accepts',
    markdown: `Old ${rawDate({ anchorId: 'dm_old', dateISO: '2099-06-15', remind: true, lead: 1 })} end.`,
    pins: 'a token the strict parse refuses (boolean remind) is salvaged: hasTime false, remind none, dateFormat relative, timeFormat system'
  },
  {
    name: 'date mention: an unparseable token stays text',
    markdown: `Bad ${rawDate('not an object')} and ((date:bm90IGpzb24)) end.`,
    pins: 'a payload that is not a JSON object, or not JSON, stays text'
  },
  {
    name: 'link mention: in body text',
    markdown: `See ${mention('https://example.com/a_b?x=1')} here.`,
    pins: 'a linkMention node: url from the token, domain its hostname, title, favicon and siteName empty'
  },
  {
    name: 'link mention: www host',
    markdown: `See ${mention('https://www.example.com/page')} here.`,
    pins: 'the domain drops the leading www.'
  },
  {
    name: 'link mention: in italics stays text',
    markdown: `A *${mention('https://example.com/a')}* b.`,
    pins: 'a token in a styled run stays text in that run (#4652)'
  },
  {
    name: 'link mention: in a table cell',
    markdown: `| a | b |\n| - | - |\n| ${mention('https://example.com/cell')} | x |`,
    pins: 'a token in a table cell is promoted'
  },
  {
    name: 'link mention and date mention: in one paragraph',
    markdown: `See ${mention('https://example.com/a')} by ${date()} ok.`,
    pins: 'both kinds promote in one paragraph, in document order'
  }
]
