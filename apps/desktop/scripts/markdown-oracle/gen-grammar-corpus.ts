/**
 * Writes `packages/contracts/test-vectors/markdown-convert/corpus/`: a
 * `<rule>.pos.md` and `<rule>.neg.md` per entry of `grammar-rules.ts`, and the
 * manifest the coverage check in `markdown-convert.test.ts` reads. Run through
 * the `vectors:markdown-convert` script, before `generate.ts` reads the files.
 */
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { GRAMMAR_RULES } from './grammar-rules'

export const CORPUS_DIR = join(
  dirname(fileURLToPath(import.meta.url)),
  '../../../../packages/contracts/test-vectors/markdown-convert/corpus'
)

export function writeGrammarCorpus(): void {
  rmSync(CORPUS_DIR, { recursive: true, force: true })
  mkdirSync(CORPUS_DIR, { recursive: true })
  const manifest = GRAMMAR_RULES.map(({ id, section }) => ({ id, section }))
  if (new Set(manifest.map((r) => r.id)).size !== manifest.length)
    throw new Error('duplicate rule id')
  for (const rule of GRAMMAR_RULES) {
    if (rule.pos === rule.neg) throw new Error(`${rule.id}: positive equals negative`)
    writeFileSync(join(CORPUS_DIR, `${rule.id}.pos.md`), rule.pos)
    writeFileSync(join(CORPUS_DIR, `${rule.id}.neg.md`), rule.neg)
  }
  writeFileSync(join(CORPUS_DIR, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`)
}
