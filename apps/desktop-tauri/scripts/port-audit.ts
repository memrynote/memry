import { readFileSync, globSync } from 'node:fs'
import { resolve, relative, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

export type HitKind = 'window.api' | 'ipcRenderer' | 'electron-toolkit' | 'window.electron'

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
  { kind: 'window.electron', regex: /window\.electron\b/ }
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

function runCli(): void {
  const here = dirname(fileURLToPath(import.meta.url))
  const root = resolve(here, '../src')

  const files = globSync('**/*.{ts,tsx}', { cwd: root }).map((relPath) =>
    resolve(root, relPath)
  )

  const hits: Hit[] = []
  for (const file of files) {
    const content = readFileSync(file, 'utf-8')
    hits.push(...scanContent(content, file))
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
