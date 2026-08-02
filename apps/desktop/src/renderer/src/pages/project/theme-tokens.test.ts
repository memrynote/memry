import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

// The renderer suite runs in jsdom, where `import.meta.url` is not a file: URL.
// Vitest's cwd is apps/desktop.
const HUB_DIR = join(process.cwd(), 'src/renderer/src/pages/project')
const BASE_CSS = join(process.cwd(), 'src/renderer/src/assets/base.css')

/**
 * Tailwind silently drops a class whose token does not exist — `bg-surface-hover`
 * compiles to nothing and the element simply has no hover state. Nothing in
 * lint, typecheck or a jsdom render catches it, and jsdom has no layout or
 * cascade, so only a source-level check like this one can.
 *
 * Scoped to the project hub so it lands without inheriting pre-existing
 * offenders elsewhere in the renderer.
 */
function definedColorTokens(): Set<string> {
  const css = readFileSync(BASE_CSS, 'utf8')
  const tokens = new Set<string>()
  for (const match of css.matchAll(/--color-([a-z0-9-]+)\s*:/g)) tokens.add(match[1])
  return tokens
}

function sourceFiles(dir: string): string[] {
  const out: string[] = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) out.push(...sourceFiles(full))
    else if (entry.name.endsWith('.tsx')) out.push(full)
  }
  return out
}

describe('project hub theme tokens', () => {
  const tokens = definedColorTokens()

  it('reads the theme tokens from base.css', () => {
    expect(tokens.has('surface')).toBe(true)
    expect(tokens.has('accent')).toBe(true)
  })

  it('only uses colour tokens that base.css defines', () => {
    // Token roots this app owns. A class whose first segment is one of these is
    // ours, so an undefined full name is a typo rather than a Tailwind builtin.
    const roots = ['surface', 'accent', 'muted', 'foreground', 'border', 'sidebar', 'destructive']
    const classPattern = /(?:^|[\s'"`])(?:[a-z-]+:)*(?:bg|text|border)-([a-z][a-z0-9-]*)/g

    const offenders: string[] = []

    for (const file of sourceFiles(HUB_DIR)) {
      const source = readFileSync(file, 'utf8')
      for (const match of source.matchAll(classPattern)) {
        const name = match[1]
        const root = name.split('-')[0]
        if (!roots.includes(root)) continue
        if (tokens.has(name)) continue
        offenders.push(`${file.replace(HUB_DIR, '')} → ${match[0].trim()}`)
      }
    }

    expect([...new Set(offenders)]).toEqual([])
  })
})
