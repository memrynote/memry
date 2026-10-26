/**
 * The synthetic vault of the seed builders, as vector cases: the bodies
 * `generateBulkVault` writes for `seed-bench-vault.ts` (a seeded PRNG, so the
 * bytes do not move from run to run), every fourth note of 1000. All of it is
 * authored in this repository; no user content enters the class. The demo seed
 * (`seed-data/notes.ts` and the others) stamps dates relative to today and
 * random note ids into its bodies, so it cannot be a committed vector. The
 * `corpus.oracle.ts` run covers it instead.
 */
import { generateBulkVault } from '../seed-data/bulk-notes'
import type { OracleCase } from './cases-frontmatter'
import { GRAMMAR_RULES } from './grammar-rules'

const SEED = 0x1848
const COUNT = 1000
const EVERY = 4

export function seedCorpusCases(): OracleCase[] {
  return generateBulkVault(COUNT, SEED)
    .notes.filter((_, index) => index % EVERY === 0)
    .map((note, index) => ({
      id: `seed-corpus/corpus-note/n${String(index).padStart(4, '0')}`,
      op: 'corpus-note',
      input: { markdown: note.file.body }
    }))
}

/** One note per rule file of `grammar-rules.ts`, positive and negative. */
export function grammarCorpusCases(): OracleCase[] {
  return GRAMMAR_RULES.flatMap((rule) =>
    (['pos', 'neg'] as const).map((kind) => ({
      id: `grammar-corpus/corpus-note/${rule.id}.${kind}`,
      op: 'corpus-note',
      input: { markdown: rule[kind] }
    }))
  )
}
