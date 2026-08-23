// Resolver-based importer rewrite: repoints any specifier (from/require/import()/vi.mock)
// that resolves to a moved file onto its @memry/sync-client subpath.
// Usage: node rewrite-imports.mjs <name> [<name>...]  (names relative to old sync dir, no .ts)
import fs from 'node:fs'
import path from 'node:path'

const OLDS = path.resolve('apps/desktop/src/main/sync')
const names = process.argv.slice(2)
const map = new Map(names.map((m) => [path.join(OLDS, m + '.ts'), '@memry/sync-client/' + m]))

function walk(d, o = []) {
  for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    if (e.name === 'node_modules' || e.name === '.git') continue
    const p = path.join(d, e.name)
    if (e.isDirectory()) walk(p, o)
    else if (/\.(ts|tsx|mts|cts)$/.test(e.name)) o.push(p)
  }
  return o
}
const roots = ['apps/desktop/src', 'apps/desktop/tests', 'packages'].filter((r) => fs.existsSync(r))
const files = roots
  .flatMap((r) => walk(path.resolve(r)))
  .filter((f) => !f.includes(path.sep + 'sync-client' + path.sep))
let changed = 0
for (const f of files) {
  const src = fs.readFileSync(f, 'utf8')
  const out = src.replace(
    /((?:from\s+|require\(|import\(|vi\.mock\()\s*)(['"])([^'"]+)\2/g,
    (all, pre, q, spec) => {
      let resolved = null
      if (spec.startsWith('.')) resolved = path.resolve(path.dirname(f), spec)
      else if (spec.startsWith('@main/')) resolved = path.resolve('apps/desktop/src/main', spec.slice(6))
      if (!resolved) return all
      if (!resolved.endsWith('.ts')) resolved += '.ts'
      const t = map.get(resolved)
      return t ? pre + q + t + q : all
    }
  )
  if (out !== src) {
    fs.writeFileSync(f, out)
    changed++
    console.log('rewrote', path.relative(process.cwd(), f))
  }
}
console.log('changed:', changed)
