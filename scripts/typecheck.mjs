#!/usr/bin/env node
// Type gate: `oxlint --type-check` (typescript-go) over exactly the files each tsconfig covers.
// oxlint picks the program per file from the nearest tsconfig.json and its `references`, and checks
// every file it is given. A tsconfig `exclude` is therefore not honoured, so a file that a project
// excludes (the desktop test backlog) would be checked against an inferred program and fail.
// `tsc --listFilesOnly` resolves include/exclude once, and only those files reach oxlint.
//
// usage (from a package dir): node ../../scripts/typecheck.mjs [tsconfig.json ...]
import { execFileSync, spawnSync } from 'node:child_process'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const bin = (name) => join(root, 'node_modules', '.bin', name)
const cwd = process.cwd()
const configs = process.argv.length > 2 ? process.argv.slice(2) : ['tsconfig.json']

const files = new Set()
for (const config of configs) {
  const listing = execFileSync(bin('tsc'), ['-p', config, '--listFilesOnly'], {
    cwd,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024
  })
  for (const line of listing.split('\n')) {
    const path = line.trim()
    if (!path || path.includes(`${sep}node_modules${sep}`)) continue
    // Every tsconfig here sets skipLibCheck, so tsc never reports diagnostics from declaration files.
    if (path.endsWith('.d.ts')) continue
    const rel = relative(cwd, path)
    // Files of sibling packages belong to their own gate and tsconfig.
    if (rel.startsWith('..')) continue
    files.add(rel)
  }
}

if (files.size === 0) {
  console.error(`typecheck: ${configs.join(', ')} matched no files`)
  process.exit(1)
}

const args = [
  '-c',
  join(root, 'config', 'oxlint-typecheck.json'),
  '--type-aware',
  '--type-check',
  '-A',
  'all'
]
const budget = process.platform === 'win32' ? 24_000 : 400_000
const sorted = [...files].toSorted((a, b) => (a < b ? -1 : a > b ? 1 : 0))
let failed = false
for (let i = 0; i < sorted.length;) {
  const chunk = []
  for (let size = 0; i < sorted.length && size < budget; i++) {
    chunk.push(sorted[i])
    size += sorted[i].length + 1
  }
  const result = spawnSync(bin('oxlint'), [...args, ...chunk], { cwd, stdio: 'inherit' })
  if (result.status !== 0) failed = true
}
process.exit(failed ? 1 : 0)
