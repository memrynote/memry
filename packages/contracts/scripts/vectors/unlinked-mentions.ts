import {
  findPlainMentions,
  findUnlinkedMentions,
  linkUnlinkedMention
} from '@memry/shared/unlinked-mentions'
import { meta } from './shared'

const CASES: Array<{ name: string; pins: string; text: string; names: string[] }> = [
  {
    name: 'ascii-case',
    pins: 'matching ignores case',
    text: 'The plan, the Plan and the PLAN.',
    names: ['Plan']
  },
  {
    name: 'whole-word',
    pins: 'a name inside a longer word is not a mention',
    text: 'planning, airplane, plan_b, plan2, plan.',
    names: ['Plan']
  },
  {
    name: 'longest-first',
    pins: 'at one position the longest name wins, and the scan resumes after it',
    text: 'Project Plan review, then the plan.',
    names: ['Plan', 'Project Plan']
  },
  {
    name: 'aliases',
    pins: 'title and every alias match',
    text: 'Met the Roadmap team about Q3 Goals.',
    names: ['Q3 Goals', 'Roadmap']
  },
  {
    name: 'short-names-skipped',
    pins: 'a name under three characters is skipped; three is enough',
    text: 'AI and ML in the API.',
    names: ['AI', 'ML', 'API']
  },
  {
    name: 'trimmed-and-deduped',
    pins: 'names are trimmed; two spellings of one name match once',
    text: 'Kickoff day.',
    names: ['  kickoff ', 'Kickoff']
  },
  {
    name: 'turkish-fold',
    pins: 'İ folds to i, ı stays ı',
    text: 'istanbul and İSTANBUL, not ıstanbul.',
    names: ['İstanbul']
  },
  {
    name: 'final-sigma',
    pins: 'final sigma matches medial sigma',
    text: 'οδοσ and ΟΔΟΣ.',
    names: ['οδος']
  },
  {
    name: 'unicode-boundary',
    pins: 'a non-ASCII letter is a word character',
    text: 'Caféplan, plané, café plan.',
    names: ['plan']
  },
  {
    name: 'punctuation-name',
    pins: 'a name may hold punctuation; its ends still need a boundary',
    text: 'Ask K.Y. or k.y.z today.',
    names: ['K.Y.']
  },
  {
    name: 'astral',
    pins: 'characters outside the BMP count once',
    text: '🚀 Launch 🚀launch',
    names: ['🚀 Launch']
  },
  { name: 'none', pins: 'no names, no mentions', text: 'Anything at all.', names: [] }
]

/**
 * Mentions in a markdown body (desktop scans files): what is blanked before the scan, the
 * offsets (UTF-16 units into `markdown`), and the body after the `ordinal`-th one is linked.
 */
const MARKDOWN_CASES: Array<{
  name: string
  pins: string
  markdown: string
  names: string[]
  title: string
  ordinal: number
}> = [
  {
    name: 'code',
    pins: 'code spans and fenced code are not scanned',
    markdown: 'Plan `Plan` here.\n\n```\nPlan\n```\n\nplan again',
    names: ['Plan'],
    title: 'Plan',
    ordinal: 1
  },
  {
    name: 'comments',
    pins: 'HTML and Obsidian comments are not scanned',
    markdown: '<!-- Plan -->\nPlan %% Plan %% PLAN\n',
    names: ['Plan'],
    title: 'Plan',
    ordinal: 1
  },
  {
    name: 'links',
    pins: 'wiki links, embeds, markdown links and images are not scanned',
    markdown: '[[Plan]] [[Other|Plan]] ![[Plan.png]] [Plan](Plan.md) ![Plan](plan.png) Plan',
    names: ['Plan'],
    title: 'Plan',
    ordinal: 0
  },
  {
    name: 'urls',
    pins: 'a URL that starts a word is not scanned',
    markdown: 'See https://example.com/plan and (ftp://x/plan) then plan.',
    names: ['Plan'],
    title: 'Plan',
    ordinal: 0
  },
  {
    name: 'url-inside-a-word',
    pins: 'a scheme preceded by a letter, digit, +, . or - is not a URL',
    markdown: 'éhttps://plan.example and 1http://plan',
    names: ['Plan'],
    title: 'Plan',
    ordinal: 1
  },
  {
    name: 'url-scheme-letters',
    pins: 'a scheme letter is an ASCII letter, or ſ or the Kelvin sign, which fold to s and k under the i and u flags; a scheme can hold +, . and -',
    markdown: '\u017F://x/plan \u212A://x/plan x+https://plan a.http://plan b-ftp://plan then plan',
    names: ['Plan'],
    title: 'Plan',
    ordinal: 0
  },
  {
    name: 'unclosed',
    pins: 'an unclosed link or comment is text',
    markdown: '[[Plan and [Plan](x plan <!-- plan',
    names: ['Plan'],
    title: 'Plan',
    ordinal: 2
  },
  {
    name: 'offsets-after-masked-non-ascii',
    pins: 'offsets index the markdown after blanked astral and accented text',
    markdown: '`😀é` [[ü]] Plan',
    names: ['Plan'],
    title: 'Plan',
    ordinal: 0
  },
  {
    name: 'alias-link',
    pins: 'a mention spelled otherwise links as [[Title|text]]',
    markdown: 'The roadmap and the Roadmap.',
    names: ['Q3 Plan', 'Roadmap'],
    title: 'Q3 Plan',
    ordinal: 1
  },
  {
    name: 'ordinal-out-of-range',
    pins: 'a mention that is gone links nothing',
    markdown: 'Plan once.',
    names: ['Plan'],
    title: 'Plan',
    ordinal: 1
  }
]

export function buildUnlinkedMentions(): Record<string, unknown> {
  const cases = CASES.map((c) => ({
    ...c,
    expected: findPlainMentions(c.text, c.names).map((mention) => mention.text)
  }))
  const markdown = MARKDOWN_CASES.map((c) => ({
    ...c,
    expected: findUnlinkedMentions(c.markdown, c.names),
    linked: linkUnlinkedMention(c.markdown, c.names, c.ordinal, c.title)
  }))
  return {
    meta: meta({
      class: 'unlinked-mentions',
      chapter: 'docs/protocol/12-note-body-format.md',
      source: 'packages/shared/src/unlinked-mentions.ts',
      caseCount: cases.length + markdown.length
    }),
    cases,
    markdown
  }
}
