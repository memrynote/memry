// The lookup tables of mathml-to-latex 1.8.0 (the version Defuddle's math.full.js requires) as
// JSON, the file `elements/math/mathml/tables.rs` loads. The tables are object literals in the
// package's `dist/index.mjs`; they are evaluated, so a duplicate key keeps its last value as it
// does in JS. `generate-article-vectors.mjs` writes and `--check`s the file with the vectors, so a
// `mathml-to-latex` bump forces a re-port decision.
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { runInNewContext } from 'node:vm'
import { join } from 'node:path'
import { dist } from './probes.mjs'
import { repoRoot } from './paths.mjs'

export const tablesTarget = join(
  repoRoot,
  'crates/memry-desktop/src/web/extract/elements/math/mathml/tables.json'
)

const require = createRequire(join(dist, 'x.js'))
const source = readFileSync(
  require.resolve('mathml-to-latex').replace(/index\.cjs$/, 'index.mjs'),
  'utf8'
)

const names = [
  'allMathOperatorsByChar',
  'allMathOperatorsByGlyph',
  'allMathSymbolsByChar',
  'allMathSymbolsByGlyph',
  'mathNumberByGlyph',
  'vowelsWithAccents',
  'accentToLTXCmd',
  'specialFontChars'
]

export function mathmlTablesText() {
  const tables = {}
  for (const name of names) {
    const match = new RegExp(`^const ${name} = (\\{[\\s\\S]*?\\n\\});$`, 'm').exec(source)
    if (!match) throw new Error(`table ${name} not found in mathml-to-latex`)
    const table = runInNewContext(`(${match[1]})`)
    tables[name] = Object.entries(table).map(([key, value]) => [key, value])
  }

  const lines = Object.entries(tables).map(
    ([name, entries]) => `  ${JSON.stringify(name)}: ${JSON.stringify(entries)}`
  )
  return `{\n${lines.join(',\n')}\n}\n`
}
