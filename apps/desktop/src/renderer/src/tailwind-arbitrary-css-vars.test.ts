import { describe, it, expect } from 'vitest'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join, relative } from 'node:path'

// The renderer suite runs in jsdom, where `import.meta.url` is not a file: URL.
// Vitest's cwd is apps/desktop under the package script, but the repo root when
// the config is pointed at from a workspace-level run, so accept either.
const RENDERER_DIR = [
  join(process.cwd(), 'src/renderer/src'),
  join(process.cwd(), 'apps/desktop/src/renderer/src')
].find((candidate) => existsSync(candidate))

if (!RENDERER_DIR) throw new Error('Could not locate the renderer source directory')

/**
 * Tailwind v3 wrapped a bare dashed-ident inside an arbitrary value in `var()`
 * for you, so `w-[--radix-popover-trigger-width]` produced
 * `width: var(--radix-popover-trigger-width)`. Tailwind v4 removed that
 * shorthand and introduced `w-(--x)` in its place. Compiled through this
 * workspace's tailwindcss 4.1.18, the old form now emits
 * `width: --radix-popover-trigger-width` — a custom-property *name* where a
 * value belongs. That is invalid CSS, so the browser discards the declaration
 * and the utility silently does nothing.
 *
 * Nothing else catches this. It type-checks (it is a string), it lints clean,
 * and jsdom has no cascade, so a render test only sees the class name. Worse,
 * tailwind-merge still recognises the dead class as a real utility, so it wins
 * conflict resolution and strips the working fallback next to it — leaving the
 * element with no rule at all rather than the pre-upgrade default.
 *
 * Both surviving forms are allowed: `-(--x)` and `-[var(--x)]`. Only the
 * bare-dashed `-[--x]` is banned.
 */
const BARE_DASHED_ARBITRARY = /-\[--[A-Za-z0-9_-]+\]/g

function sourceFiles(dir: string): string[] {
  const out: string[] = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) {
      out.push(...sourceFiles(full))
      continue
    }
    if (!/\.(ts|tsx)$/.test(entry.name)) continue
    // Test files quote the banned form on purpose, to assert its absence.
    if (/\.(test|spec)\.tsx?$/.test(entry.name)) continue
    out.push(full)
  }
  return out
}

describe('Tailwind v4 arbitrary CSS variables', () => {
  it('never uses the v3 bare-dashed form, which compiles to invalid CSS', () => {
    const offenders: string[] = []

    for (const file of sourceFiles(RENDERER_DIR)) {
      const source = readFileSync(file, 'utf8')
      for (const match of source.matchAll(BARE_DASHED_ARBITRARY)) {
        offenders.push(`${relative(RENDERER_DIR, file)}: ${match[0]}`)
      }
    }

    expect(offenders).toEqual([])
  })
})
