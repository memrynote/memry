#!/usr/bin/env node
// Prints the e2e specs changed since a base commit, space separated, for `wdio --spec`. wdio has
// no `--only-changed`.
//
//   node e2e/scripts/changed-specs.mjs <base-sha>
import { execFileSync } from 'node:child_process'
import { dirname, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const e2eRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const SPEC = /^e2e\/specs\/.+\.e2e\.ts$/

/** Added, modified and renamed spec paths of a `git diff --name-only` listing. */
export function filterSpecs(lines) {
  return lines.map((line) => line.trim()).filter((line) => SPEC.test(line))
}

export function changedSpecs(base, cwd = resolve(e2eRoot, '..')) {
  const output = execFileSync(
    'git',
    ['diff', '--name-only', '--diff-filter=AMR', '--relative', `${base}`, '--', 'e2e/specs'],
    { cwd, encoding: 'utf8' }
  )
  return filterSpecs(output.split('\n'))
}

function main() {
  const base = process.argv[2]
  if (!base) {
    console.error('usage: changed-specs.mjs <base-sha>')
    process.exit(2)
  }
  console.log(changedSpecs(base).join(' '))
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) main()
