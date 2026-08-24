import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * Which of the two drizzle migration sets to resolve: `data` (notes, tasks,
 * projects) or `index` (search, graph).
 */
export type MigrationsKind = 'data' | 'index'

/** Env override, so a packager or a debug run can point at an explicit folder. */
export const migrationsDirEnvVar = 'MEMRY_MIGRATIONS_DIR'

/** Where the migrations live inside a source checkout, relative to the repo root. */
const sourceMigrationsParent = path.join('apps', 'desktop', 'src', 'main', 'database')

export interface MigrationsLookup {
  /** Directory of the module doing the lookup. */
  moduleDir: string
  /** Process working directory, kept as the last-resort search root. */
  cwd: string
  /** Raw value of {@link migrationsDirEnvVar}, if set. */
  envDir?: string
}

function folderName(kind: MigrationsKind): string {
  return `drizzle-${kind}`
}

function ancestors(start: string): string[] {
  const chain: string[] = []
  let current = path.resolve(start)
  for (;;) {
    chain.push(current)
    const parent = path.dirname(current)
    if (parent === current) return chain
    current = parent
  }
}

/**
 * Every place a migration folder could plausibly be, in the order we trust it.
 *
 * Order matters: an explicit override beats the bundle, and the bundle beats a
 * source checkout, so a packaged binary never wanders into whatever tree the
 * user happened to launch it from.
 */
export function migrationsDirCandidates(kind: MigrationsKind, lookup: MigrationsLookup): string[] {
  const name = folderName(kind)
  const candidates: string[] = []

  if (lookup.envDir) candidates.push(path.resolve(lookup.envDir, name))

  // Packaged: app-core is bundled into out/main/index.js and electron.vite's
  // copyMigrations() plugin drops the folders next to it. The parent is
  // insurance in case rollup ever emits the bundle into out/main/chunks/.
  candidates.push(path.join(lookup.moduleDir, name))
  candidates.push(path.join(path.dirname(lookup.moduleDir), name))

  // Source checkout: the nearest ancestor that actually holds the folders.
  // Anchored to the module first so a git worktree resolves to itself instead
  // of the outer main checkout it is nested inside.
  for (const dir of [...ancestors(lookup.moduleDir), ...ancestors(lookup.cwd)]) {
    candidates.push(path.join(dir, sourceMigrationsParent, name))
  }

  return [...new Set(candidates)]
}

/**
 * A directory only counts as a migration folder if drizzle's journal is there —
 * matching on the path alone is what let a packaged build hand drizzle a
 * directory that does not exist (issue #1722).
 */
export function isMigrationsDir(dir: string): boolean {
  return fs.existsSync(path.join(dir, 'meta', '_journal.json'))
}

function defaultLookup(): MigrationsLookup {
  return {
    moduleDir: fileURLToPath(new URL('.', import.meta.url)),
    cwd: process.cwd(),
    envDir: process.env[migrationsDirEnvVar] || undefined
  }
}

/**
 * Resolve the drizzle migration folder for `kind`, or throw naming what was
 * tried — drizzle's own failure is a bare "Can't find meta/_journal.json file"
 * with no path in it, which is unactionable from a packaged binary's stderr.
 */
export function resolveMigrationsDir(
  kind: MigrationsKind,
  lookup: MigrationsLookup = defaultLookup()
): string {
  const candidates = migrationsDirCandidates(kind, lookup)
  const found = candidates.find(isMigrationsDir)
  if (found) return found

  throw new Error(
    `Could not find the ${folderName(kind)} migrations folder. Tried:\n` +
      candidates.map((dir) => `  - ${dir}`).join('\n') +
      `\nSet ${migrationsDirEnvVar} to the directory containing drizzle-data/ and drizzle-index/ to override.`
  )
}
