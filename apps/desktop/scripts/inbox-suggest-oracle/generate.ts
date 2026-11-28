/**
 * Generates `packages/contracts/test-vectors/inbox-suggest.json` by running
 * Electron's folder scorer (`src/main/inbox/folder-scoring.ts`) in place as the
 * oracle for the Rust port (`crates/memry-core/src/domain/inbox/suggest.rs`).
 *
 *   pnpm --filter @memry/desktop vectors:inbox-suggest          # write the file
 *   pnpm --filter @memry/desktop vectors:inbox-suggest:check    # regenerate in memory, diff, write nothing
 *
 * The inputs are the ones `folder-scoring.test.ts` uses, plus cases on each
 * constant's edge: ancestor depth, the support cap, ties, the floor, `limit`.
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  corroboratedSimilarity,
  scoreFolders,
  type FolderHit
} from '../../src/main/inbox/folder-scoring'

const appRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')
const PATH = join(resolve(appRoot, '../../packages/contracts/test-vectors'), 'inbox-suggest.json')

interface ScoreCase {
  name: string
  hits?: FolderHit[]
  nameMatches?: [string, number][]
  tagMatches?: [string, number][]
  exclude?: string[]
  minConfidence?: number
  limit?: number
}

const h = (folder: string, similarity: number, noteTitle?: string): FolderHit =>
  noteTitle === undefined ? { folder, similarity } : { folder, similarity, noteTitle }

const SCORE_CASES: ScoreCase[] = [
  {
    name: 'cluster beats a fluke',
    hits: [h('recipes', 0.6), h('recipes', 0.6), h('recipes', 0.6), h('misc', 0.7)]
  },
  {
    name: 'volume does not beat a strong cluster',
    hits: [
      ...Array.from({ length: 10 }, () => h('archive', 0.45)),
      h('recipes', 0.75),
      h('recipes', 0.72),
      h('recipes', 0.7)
    ]
  },
  {
    name: 'siblings roll up to their parent',
    hits: [
      h('projects/ProjectA/sub1', 0.6),
      h('projects/ProjectA/sub2', 0.6),
      h('projects/ProjectA/sub3', 0.6)
    ]
  },
  { name: 'no rollup into the root', hits: [h('recipes', 0.6), h('travel', 0.6)] },
  { name: 'name only', hits: [], nameMatches: [['recipes', 0.9]] },
  {
    name: 'name lifts a tie',
    hits: [h('recipes', 0.5), h('misc', 0.5)],
    nameMatches: [['recipes', 0.9]]
  },
  { name: 'tag only', hits: [], tagMatches: [['cooking', 0.8]] },
  {
    name: 'exclude',
    hits: [h('recipes', 0.6), h('current', 0.9)],
    exclude: ['current']
  },
  { name: 'limit', hits: [h('a', 0.6), h('b', 0.55), h('c', 0.5)], limit: 2 },
  {
    name: 'best note title',
    hits: [h('recipes', 0.6, 'Pasta'), h('recipes', 0.8, 'Risotto')]
  },
  {
    name: 'minimum confidence',
    hits: [h('strong', 0.8), h('strong', 0.8), h('strong', 0.8), h('weak', 0.5)],
    minConfidence: 0.5
  },
  { name: 'no signals', hits: [] },
  {
    name: 'deep ancestors decay per level',
    hits: [h('a/b/c/d', 0.9, 'Deep'), h('a/b/x', 0.7, 'Mid'), h('a/y', 0.5)]
  },
  {
    name: 'support caps at three and two hits are discounted',
    hits: [
      h('two', 0.9),
      h('two', 0.8),
      h('four', 0.9),
      h('four', 0.85),
      h('four', 0.1),
      h('four', 0.95)
    ]
  },
  {
    name: 'equal confidence keeps candidate order',
    hits: [h('z', 0.6), h('y', 0.6)],
    nameMatches: [['x', 0.6]],
    tagMatches: [['w', 0.6]]
  },
  {
    name: 'all three signals blend',
    hits: [h('food/italian', 0.7, 'Carbonara'), h('food/italian', 0.65, 'Lasagne')],
    nameMatches: [
      ['food/italian', 0.5],
      ['food', 1]
    ],
    tagMatches: [
      ['food/italian', 1],
      ['wine', 0.5]
    ],
    minConfidence: 0.45,
    limit: 3
  },
  {
    name: 'floor sits on the confidence',
    hits: [],
    nameMatches: [
      ['exact', 0.45],
      ['under', 0.44999999999999996]
    ],
    minConfidence: 0.45
  },
  {
    name: 'zero name and tag scores are not signals',
    hits: [],
    nameMatches: [['zero', 0]],
    tagMatches: [['zero', 0]]
  },
  {
    name: 'root hit',
    hits: [h('', 0.7, 'Inbox'), h('', 0.6)]
  }
]

const CORROBORATION_CASES: number[][] = [
  [],
  [0.9],
  [0.9, 0.5],
  [0.9, 0.5, 0.7],
  [0.1, 0.9, 0.5, 0.7, 0.95],
  [0.3333, 0.6667]
]

function build(): string {
  const scores = SCORE_CASES.map((c) => ({
    ...c,
    expected: scoreFolders({
      hits: c.hits,
      nameMatches: c.nameMatches ? new Map(c.nameMatches) : undefined,
      tagMatches: c.tagMatches ? new Map(c.tagMatches) : undefined,
      exclude: c.exclude,
      minConfidence: c.minConfidence,
      limit: c.limit
    })
  }))
  const corroboration = CORROBORATION_CASES.map((sims) => ({
    sims,
    expected: corroboratedSimilarity(sims)
  }))
  return `${JSON.stringify({ scores, corroboration }, null, 2)}\n`
}

const text = build()
if (process.argv.includes('--check')) {
  if (readFileSync(PATH, 'utf8') !== text) {
    console.error(`${PATH} is stale: run pnpm --filter @memry/desktop vectors:inbox-suggest`)
    process.exit(1)
  }
} else {
  writeFileSync(PATH, text)
}
