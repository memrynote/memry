/**
 * Writes `packages/contracts/test-vectors/markdown-convert/corpus/`: a
 * `<rule>.pos.md` and `<rule>.neg.md` per entry of `grammar-rules.ts`, and the
 * manifest the coverage check in `markdown-convert.test.ts` reads. Run through
 * the `vectors:markdown-convert` script, before `generate.ts` reads the files.
 */
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { GRAMMAR_RULES } from './grammar-rules'

export const CORPUS_DIR = join(
  dirname(fileURLToPath(import.meta.url)),
  '../../../../packages/contracts/test-vectors/markdown-convert/corpus'
)

const PROTOCOL = join(CORPUS_DIR, '../../../../../docs/protocol/12-note-body-format.md')

/** The rule ids of the index in protocol 12.8.1, the source of the identifiers. */
export function protocolRuleIds(): { id: string; section: string }[] {
  const text = readFileSync(PROTOCOL, 'utf8')
  const start = text.indexOf('### 12.8.1 Rule index of the conformance corpus')
  const end = text.indexOf('\n## 12.9', start)
  if (start < 0 || end < 0) throw new Error('protocol 12.8.1 is missing')
  return [...text.slice(start, end).matchAll(/^\| `([a-z0-9-]+)`\s+\| §(12\.[678])\s+\|/gm)].map(
    (m) => ({
      id: m[1],
      section: m[2]
    })
  )
}

export function writeGrammarCorpus(): void {
  rmSync(CORPUS_DIR, { recursive: true, force: true })
  mkdirSync(CORPUS_DIR, { recursive: true })
  const manifest = protocolRuleIds()
  const mine = GRAMMAR_RULES.map(({ id, section }) => `${section} ${id}`).toSorted()
  const theirs = manifest.map(({ id, section }) => `${section} ${id}`).toSorted()
  if (JSON.stringify(mine) !== JSON.stringify(theirs)) {
    throw new Error(
      'grammar-rules.ts and protocol 12.8.1 disagree on the rule ids: ' +
        [
          ...mine.filter((r) => !theirs.includes(r)),
          ...theirs.filter((r) => !mine.includes(r))
        ].join(', ')
    )
  }
  if (new Set(manifest.map((r) => r.id)).size !== manifest.length)
    throw new Error('duplicate rule id')
  for (const rule of GRAMMAR_RULES) {
    if (rule.pos === rule.neg) throw new Error(`${rule.id}: positive equals negative`)
    writeFileSync(join(CORPUS_DIR, `${rule.id}.pos.md`), rule.pos)
    writeFileSync(join(CORPUS_DIR, `${rule.id}.neg.md`), rule.neg)
  }
  writeFileSync(join(CORPUS_DIR, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`)
}
