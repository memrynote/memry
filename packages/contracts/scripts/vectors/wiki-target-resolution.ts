import {
  nameKey,
  normalizeAliases,
  pickWikiTarget,
  type WikiNameCandidate
} from '@memry/shared/note-names'
import { meta } from './shared'

const NAME_KEYS: Array<{ name: string; pins: string; input: string }> = [
  { name: 'ascii-case', pins: 'ASCII letters lowercase', input: 'Project Plan' },
  { name: 'turkish-dotted-capital-i', pins: 'İ folds to i, as tags do', input: 'İstanbul' },
  { name: 'turkish-dotless-i', pins: 'ı stays ı', input: 'ışık' },
  { name: 'sharp-s', pins: 'ß stays ß, no full case folding to ss', input: 'Straße' },
  { name: 'final-sigma', pins: 'final sigma folds to σ in any position', input: 'ΟΔΟΣ' },
  { name: 'nfc', pins: 'NFD input composes before folding', input: 'Cafe\u0301' },
  {
    name: 'whitespace',
    pins: 'tabs, NBSP and runs collapse to one space; ends trimmed',
    input: ' \tQ3\u00a0 \u2003plan\n'
  },
  { name: 'bom-kept', pins: 'U+FEFF is not White_Space, so it stays', input: '\ufeffPlan' },
  { name: 'empty', pins: 'whitespace only is no name', input: ' \t ' }
]

const ALIAS_LISTS: Array<{ name: string; pins: string; title: string; aliases: string[] }> = [
  {
    name: 'dedupe-first-spelling',
    pins: 'dedupe by key, first spelling kept, entries trimmed',
    title: 'Kaan Yılmaz',
    aliases: [' K. ', 'k.', 'KY', 'ky']
  },
  {
    name: 'drops-own-title-and-empties',
    pins: 'an alias equal to the title by key and empty entries are dropped',
    title: 'Plan',
    aliases: ['PLAN', '', '  ', 'Roadmap']
  },
  {
    name: 'drops-over-long',
    pins: 'an entry over 200 characters is dropped',
    title: 'Plan',
    aliases: ['x'.repeat(201), 'y'.repeat(200)]
  }
]

const NOTES: WikiNameCandidate[] = [
  { noteId: 'n-01', path: 'Work/Plan.md', title: 'Plan', aliases: ['Roadmap'], journal: false },
  { noteId: 'n-02', path: 'Home/Plan.md', title: 'Plan', aliases: [], journal: false },
  {
    noteId: 'n-03',
    path: 'People/Kaan.md',
    title: 'Kaan',
    aliases: ['K.', 'İstanbul Office'],
    journal: false
  },
  { noteId: 'n-04', path: 'Roadmap.md', title: 'Roadmap Draft', aliases: ['Plan'], journal: false },
  { noteId: 'n-05', path: 'Shared A.md', title: 'Shared A', aliases: ['Team'], journal: false },
  { noteId: 'n-06', path: 'Shared B.md', title: 'Shared B', aliases: ['team'], journal: false },
  { noteId: 'n-07', path: 'Greek.md', title: 'ΟΔΟΣ', aliases: ['Straße'], journal: false },
  { noteId: 'n-08', path: 'Café.md', title: 'Café', aliases: [], journal: false },
  { noteId: 'n-09', path: 'plan lower.md', title: 'plan', aliases: [], journal: false },
  { noteId: 'n-10', path: 'Roadmap Two.md', title: 'Roadmap', aliases: [], journal: false },
  {
    noteId: 'n-11',
    path: 'journal/2026-01-05.md',
    title: '2026-01-05',
    aliases: ['Kickoff Day'],
    journal: true
  },
  {
    noteId: 'j-01',
    path: 'journal/2026-03-01.md',
    title: '2026-03-01',
    aliases: ['Launch Day'],
    journal: true
  },
  { noteId: 'n-12', path: '2026-03-01.md', title: '2026-03-01', aliases: [], journal: false },
  { noteId: 'n-13', path: 'Launch.md', title: 'Launch', aliases: ['launch day'], journal: false }
]

const QUERIES: Array<{ name: string; pins: string; query: string }> = [
  { name: 'path-wins', pins: 'a path half matches the path over any title', query: 'Home/Plan' },
  { name: 'path-case-and-ext', pins: 'paths fold case and accept .md', query: '/work/PLAN.md' },
  {
    name: 'path-miss',
    pins: 'an unmatched path falls back to names, and no name holds it',
    query: 'Nowhere/Plan'
  },
  { name: 'title-exact-case', pins: 'an exact-case title beats a folded one', query: 'plan' },
  { name: 'title-tie-lowest-id', pins: 'two notes titled the same: lowest id', query: 'Plan' },
  {
    name: 'title-beats-alias',
    pins: 'n-01 aliases Roadmap; n-10 is titled Roadmap',
    query: 'roadmap'
  },
  { name: 'alias', pins: 'an alias resolves when no title matches', query: 'k.' },
  {
    name: 'alias-tie-lowest-id',
    pins: 'two notes share an alias by key: lowest id',
    query: 'TEAM'
  },
  { name: 'alias-turkish', pins: 'İ folds to i on both sides', query: 'istanbul office' },
  { name: 'alias-sharp-s', pins: 'ß is not ss', query: 'strasse' },
  { name: 'alias-sharp-s-match', pins: 'ß matches ß in any case', query: 'STRAßE' },
  { name: 'title-final-sigma', pins: 'final sigma matches medial sigma', query: 'οδοσ' },
  { name: 'title-nfc', pins: 'NFD query matches an NFC title', query: 'Cafe\u0301' },
  { name: 'whitespace', pins: 'outer and inner whitespace collapse', query: '  kickoff \t day ' },
  { name: 'journal-alias', pins: 'journal entries resolve by alias too', query: 'Kickoff Day' },
  { name: 'journal-title', pins: 'journal entries resolve by date title', query: '2026-01-05' },
  {
    name: 'title-note-beats-journal',
    pins: 'a note and a journal day share a title: the note, though j-01 < n-12',
    query: '2026-03-01'
  },
  {
    name: 'alias-note-beats-journal',
    pins: 'a note and a journal day share an alias: the note, though j-01 < n-13',
    query: 'Launch Day'
  },
  { name: 'missing', pins: 'no note names it', query: 'Nothing here' },
  { name: 'empty', pins: 'an empty half names nothing', query: '   ' }
]

export function buildWikiTargetResolution(): Record<string, unknown> {
  const nameKeys = NAME_KEYS.map((c) => ({ ...c, expected: nameKey(c.input) }))
  const aliasLists = ALIAS_LISTS.map((c) => ({
    ...c,
    expected: normalizeAliases(c.title, c.aliases)
  }))
  const resolution = QUERIES.map((c) => {
    const match = pickWikiTarget(c.query, NOTES)
    return { ...c, expected: match && { noteId: match.noteId, matchedBy: match.matchedBy } }
  })
  return {
    meta: meta({
      class: 'wiki-target-resolution',
      chapter: 'docs/protocol/12-note-body-format.md',
      source: 'packages/shared/src/note-names.ts',
      caseCount: nameKeys.length + aliasLists.length + resolution.length
    }),
    nameKeys,
    aliasLists,
    notes: NOTES,
    resolution
  }
}
