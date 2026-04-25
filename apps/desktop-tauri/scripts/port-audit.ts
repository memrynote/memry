import { readFileSync, globSync } from 'node:fs'
import { resolve, relative, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

export type HitKind =
  | 'window.api'
  | 'ipcRenderer'
  | 'electron-toolkit'
  | 'window.electron'
  | 'electron-log'
  | 'electron-import'

export interface Hit {
  file: string
  line: number
  text: string
  kind: HitKind
}

const PATTERNS: Array<{ kind: HitKind; regex: RegExp }> = [
  { kind: 'window.api', regex: /window\.api\./ },
  { kind: 'ipcRenderer', regex: /\bipcRenderer\b/ },
  { kind: 'electron-toolkit', regex: /@electron-toolkit/ },
  { kind: 'window.electron', regex: /window\.electron\b/ },
  // Phase G hardening: catch leftover electron-log/* renderer imports.
  { kind: 'electron-log', regex: /['"]electron-log(?:\/[a-z]+)?['"]/ },
  // Phase G hardening: bare `from 'electron'` / `from "electron"` imports.
  { kind: 'electron-import', regex: /from\s+['"]electron['"]/ }
]

/**
 * Scans a file's contents for Electron-era references. Pure function so it can
 * be unit-tested without touching the filesystem.
 *
 * Returned hits are ordered by line number, then by pattern order. Each match
 * line can produce multiple hits if more than one pattern matches.
 */
export function scanContent(content: string, file: string): Hit[] {
  const hits: Hit[] = []
  const lines = content.split('\n')
  lines.forEach((text, i) => {
    for (const { kind, regex } of PATTERNS) {
      if (regex.test(text)) {
        hits.push({ file, line: i + 1, text: text.trim(), kind })
      }
    }
  })
  return hits
}

export function isTestFile(relPath: string): boolean {
  return /\.test\.(ts|tsx)$/.test(relPath)
}

/**
 * Counts how many lines reference a `@memry/<package>` workspace import.
 *
 * Phase G doesn't drive these to zero (legitimate `@memry/contracts` uses
 * remain), but we track totals as a carry-forward ledger for the PR — later
 * milestones graduate `@memry/rpc/*`, `@memry/db-schema/*`, and
 * `@memry/shared/*` references away from the renderer.
 */
export function countMemryRefs(content: string): number {
  const re = /@memry\//g
  return [...content.matchAll(re)].length
}

function runCli(): void {
  const here = dirname(fileURLToPath(import.meta.url))
  const root = resolve(here, '../src')

  // Test files are excluded — they mock platform APIs by design
  // (`window.api.foo = vi.fn()` is scaffolding, not a real call site).
  // Production code references live in non-test files; those are what
  // Phase H must drive to zero.
  const files = globSync('**/*.{ts,tsx}', { cwd: root })
    .filter((relPath) => !isTestFile(relPath))
    .map((relPath) => resolve(root, relPath))

  const hits: Hit[] = []
  let memryRefs = 0
  for (const file of files) {
    const content = readFileSync(file, 'utf-8')
    hits.push(...scanContent(content, file))
    memryRefs += countMemryRefs(content)
  }

  console.log(`Total hits: ${hits.length}`)

  const byKind = hits.reduce<Record<string, number>>((acc, h) => {
    acc[h.kind] = (acc[h.kind] ?? 0) + 1
    return acc
  }, {})
  console.log('By kind:', byKind)

  const byFile = new Map<string, number>()
  for (const h of hits) byFile.set(h.file, (byFile.get(h.file) ?? 0) + 1)
  console.log(`Files affected: ${byFile.size}`)

  if (byFile.size > 0) {
    console.log('\nTop 20 files by hit count:')
    Array.from(byFile.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, 20)
      .forEach(([f, c]) => console.log(`  ${c.toString().padStart(4)} ${relative(root, f)}`))
  }

  console.log(`\n@memry/* references (informational): ${memryRefs}`)

  if (hits.length > 0) {
    process.exitCode = 1
  }
}

const invokedAsScript = process.argv[1]
  ? resolve(process.argv[1]) === fileURLToPath(import.meta.url)
  : false

if (invokedAsScript) {
  runCli()
}
