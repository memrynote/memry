#!/usr/bin/env node
/**
 * Per-directory line ceilings (spec 002 plan, Constitution II).
 *
 * A file past its ceiling is asking to be split along a seam that already
 * exists. Making that a build failure rather than a review note is the whole
 * point: review notes are negotiable, `exit 1` is not.
 *
 *   node scripts/check-line-ceilings.mjs
 */
import { readdir, readFile } from 'node:fs/promises'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

// Anchored to this file, never to the caller's cwd. `scripts/` sits at the
// repo root, so this resolves the same from anywhere. With `process.cwd()`,
// running the gate from `crates/` made every rule ENOENT — which the loop
// below correctly treats as "not a violation" — so it scanned zero files and
// printed "passed". A gate that reports success having inspected nothing is
// worse than no gate, because it is believed.
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')

/** Each rule: files directly matching `dir` + `extension`, capped at `max`. */
const RULES = [
  { dir: 'crates/memry-core/src', extension: '.rs', max: 600, recursive: true },
  { dir: 'crates/memry-cli/src', extension: '.rs', max: 600, recursive: true },
  { dir: 'apps/ios/Memry/Features', extension: '.swift', max: 400, recursive: true },
  { dir: 'packages/contracts/scripts', extension: '.ts', max: 300, recursive: false }
]

const SKIP_DIRS = new Set(['node_modules', 'target', 'dist', 'Generated', '.git'])

async function filesUnder(root, extension, recursive) {
  let entries
  try {
    entries = await readdir(root, { withFileTypes: true })
  } catch (error) {
    // A directory a phase has not created yet is not a violation.
    if (error.code === 'ENOENT') return []
    throw error
  }

  const found = []
  for (const entry of entries) {
    const full = join(root, entry.name)
    if (entry.isDirectory()) {
      if (!recursive || SKIP_DIRS.has(entry.name)) continue
      found.push(...(await filesUnder(full, extension, recursive)))
    } else if (entry.name.endsWith(extension)) {
      found.push(full)
    }
  }
  return found
}

/** Trailing newline at EOF must not count as an extra line. */
function lineCount(source) {
  if (source.length === 0) return 0
  return source.endsWith('\n') ? source.split('\n').length - 1 : source.split('\n').length
}

const violations = []
let checked = 0

for (const rule of RULES) {
  for (const file of await filesUnder(join(repoRoot, rule.dir), rule.extension, rule.recursive)) {
    checked += 1
    const lines = lineCount(await readFile(file, 'utf8'))
    if (lines > rule.max) {
      violations.push(
        `${relative(repoRoot, file).split(sep).join('/')}: ${lines} lines (ceiling ${rule.max})`
      )
    }
  }
}

// The second half of the same lesson: an individual rule may legitimately
// match nothing, but every rule matching nothing means the roots are wrong.
if (checked === 0) {
  console.error('line ceiling check found no files at all — the rule roots are wrong.')
  console.error(`Resolved repo root: ${repoRoot}`)
  process.exit(1)
}

if (violations.length === 0) {
  console.log(`line ceiling check passed (${checked} files)`)
  process.exit(0)
}

console.error('line ceiling check failed:')
for (const violation of violations.sort()) console.error(`- ${violation}`)
console.error(
  '\nSplit the file along an existing seam, or move the rule in scripts/check-line-ceilings.mjs.'
)
process.exit(1)
