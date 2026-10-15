import { findPlainMentions } from '@memry/shared/unlinked-mentions'
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

export function buildUnlinkedMentions(): Record<string, unknown> {
  const cases = CASES.map((c) => ({
    ...c,
    expected: findPlainMentions(c.text, c.names).map((mention) => mention.text)
  }))
  return {
    meta: meta({
      class: 'unlinked-mentions',
      chapter: 'docs/protocol/12-note-body-format.md',
      source: 'packages/shared/src/unlinked-mentions.ts',
      caseCount: cases.length
    }),
    cases
  }
}
