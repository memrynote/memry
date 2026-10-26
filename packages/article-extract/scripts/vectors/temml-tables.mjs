// The data tables of temml 0.13.3 (the version Defuddle's math.full.js requires) as JSON, the
// file `elements/math/temml/tables.json` loads: the symbol table, the Unicode accent and
// sub/superscript tables and the macros defined as strings. They are evaluated from the
// package's own source (bundled with esbuild, since the files import each other without
// extensions), so a duplicate key keeps its last value as it does in JS. Macros defined as
// functions are listed by name; the port implements each. `generate-article-vectors.mjs` writes
// and `--check`s the file with the vectors, so a `temml` bump forces a re-port decision.
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { build } from 'esbuild'
import { dist } from './probes.mjs'
import { repoRoot } from './paths.mjs'

export const temmlTablesTarget = join(
  repoRoot,
  'crates/memry-desktop/src/web/extract/elements/math/temml/tables.json'
)

const require = createRequire(join(dist, 'x.js'))
const src = join(dirname(require.resolve('temml')), '../src')

const entry = `
import symbols, { ATOMS, NON_ATOMS, ligatures } from ${JSON.stringify(join(src, 'symbols.js'))}
import unicodeSymbols from ${JSON.stringify(join(src, 'unicodeSymbols.js'))}
import { uSubsAndSups, unicodeSubRegEx } from ${JSON.stringify(join(src, 'unicodeSupOrSub.js'))}
import { asciiFromScript } from ${JSON.stringify(join(src, 'asciiFromScript.js'))}
import macros from ${JSON.stringify(join(src, 'macros.js'))}
import ${JSON.stringify(join(src, 'functions/operatorname.js'))}
import { smalls } from ${JSON.stringify(join(src, 'utils.js'))}
export default { symbols, ATOMS, NON_ATOMS, ligatures, unicodeSymbols, uSubsAndSups, unicodeSubRegEx, asciiFromScript, macros, smalls }
`

const pairs = (obj) => Object.entries(obj)

export async function temmlTablesText() {
  const result = await build({
    stdin: { contents: entry, resolveDir: src, loader: 'js' },
    bundle: true,
    write: false,
    format: 'esm',
    logLevel: 'silent'
  })
  const code = result.outputFiles[0].text
  const mod = await import(`data:text/javascript;base64,${Buffer.from(code).toString('base64')}`)
  const t = mod.default
  const out = {
    symbols: {
      math: pairs(t.symbols.math).map(([k, v]) => [k, v.group, v.replace ?? null]),
      text: pairs(t.symbols.text).map(([k, v]) => [k, v.group, v.replace ?? null])
    },
    atoms: Object.keys(t.ATOMS),
    nonAtoms: Object.keys(t.NON_ATOMS),
    ligatures: Object.keys(t.ligatures),
    unicodeSymbols: pairs(t.unicodeSymbols),
    uSubsAndSups: pairs(t.uSubsAndSups).map(([k, v]) => [k, v, t.unicodeSubRegEx.test(k)]),
    asciiFromScript: pairs(t.asciiFromScript),
    smalls: t.smalls,
    macros: pairs(t.macros)
      .filter(([, v]) => typeof v === 'string')
      .map(([k, v]) => [k, v]),
    functionMacros: pairs(t.macros)
      .filter(([, v]) => typeof v === 'function')
      .map(([k]) => k)
  }
  const lines = Object.entries(out).map(([k, v]) => `  ${JSON.stringify(k)}: ${JSON.stringify(v)}`)
  return `{\n${lines.join(',\n')}\n}\n`
}
