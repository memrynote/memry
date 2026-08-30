#!/usr/bin/env node
/**
 * Give every git worktree the repo's gitignored environment files and local
 * dev state.
 *
 * Secrets (`apps/desktop/.env.staging`, `apps/sync-server/.dev.vars`,
 * `apps/landing/.env.local`, ...) are gitignored on purpose, so `git worktree
 * add` produces a tree that typechecks and builds but cannot talk to staging:
 * `resolveSyncServerUrl()` silently falls back to `http://localhost:8787` and
 * OAuth, Resend and Paddle all dial nothing. Copying the files by hand into
 * each of a dozen worktrees is the thing nobody does.
 *
 * This links them instead. The main worktree stays the single source of truth
 * and every other worktree gets a symlink, so rotating a key in one place
 * rotates it everywhere. The files remain gitignored at their new paths --
 * identical repo, identical .gitignore -- so nothing becomes committable.
 *
 * The same treatment goes to the gitignored state directories in SHARED_DIRS,
 * so a fresh worktree also inherits the sync server's local D1/R2 database
 * instead of booting against an empty one.
 *
 * Usage:
 *   node scripts/link-env.mjs            # link (default)
 *   node scripts/link-env.mjs --copy     # real copies instead of symlinks
 *   node scripts/link-env.mjs --check    # report only, exit 1 if anything is missing
 *   node scripts/link-env.mjs --force    # replace destination files that are not symlinks
 *
 * Override the source with MEMRY_ENV_SOURCE=/path/to/dir to keep secrets
 * outside the repo entirely.
 */

import { execFileSync } from 'node:child_process'
import {
  copyFileSync,
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readlinkSync,
  rmSync,
  symlinkSync
} from 'node:fs'
import path from 'node:path'

/** Directories never worth walking: build output, dependencies, nested worktrees. */
const SKIP_DIRS = new Set([
  '.git',
  '.next',
  '.turbo',
  '.wrangler',
  '.worktrees',
  'DerivedData',
  'Pods',
  'build',
  'coverage',
  'dist',
  'dist-electron',
  'node_modules',
  'out',
  'release',
  'worktrees'
])

/** `.env`, `.env.staging`, `electron-builder.env`, `.dev.vars`, `.xcode.env`, ... */
const ENV_FILE = /^(\.env(\..+)?|.+\.env|\.dev\.vars(\..+)?)$/

/** Templates are tracked and already present in every worktree. */
const TEMPLATE_SUFFIX = /\.(example|sample|template)$/

/** True for a basename that looks like an environment file rather than a template. */
export function isEnvFileName(name) {
  return ENV_FILE.test(name) && !TEMPLATE_SUFFIX.test(name)
}

/**
 * Gitignored *directories* of local state that a worktree needs but cannot
 * regenerate cheaply.
 *
 * `apps/sync-server/.wrangler/state` is miniflare's local D1 + R2 + Durable
 * Object storage: the sync server's dev database. A fresh worktree starts with
 * an empty one, so `pnpm dev:sync-server` there serves a schema-less database
 * and every device that syncs against it has to be re-linked and re-populated
 * by hand. Sharing the main worktree's state means one local database for all
 * worktrees -- migrate or seed it once and every tree sees the same rows.
 *
 * `.wrangler/tmp` is deliberately not shared: it is scratch space wrangler
 * recreates per run, and per-worktree scratch keeps two dev servers from
 * stepping on each other.
 *
 * `.claude/skills` is the repo's agent skill set (`/user-feedback`,
 * `/release-desktop`, `/ipc-contract-change`, ...). `.claude/` is gitignored,
 * so an agent session started in a worktree sees none of them and silently
 * falls back to ad hoc answers. Only `skills` is shared: the rest of `.claude`
 * holds per-session state and `.claude/worktrees`, which are real git
 * worktrees and must stay where they are. The skill entries that are
 * themselves symlinks into `.agents/skills` keep resolving, because the kernel
 * resolves them against the source worktree they physically live in.
 */
export const SHARED_DIRS = ['apps/sync-server/.wrangler/state', '.claude/skills']

/** Repo-relative paths from SHARED_DIRS that actually exist under `root`. */
export function findSharedDirs(root, { exists = existsSync } = {}) {
  return SHARED_DIRS.filter((rel) => exists(path.join(root, rel)))
}

/** Recursively collect repo-relative paths of env-looking files under `root`. */
export function findEnvFiles(root, { readDir = readdirSync } = {}) {
  const found = []
  const walk = (rel) => {
    let entries
    try {
      entries = readDir(rel ? path.join(root, rel) : root, { withFileTypes: true })
    } catch {
      return // unreadable directory: not our problem to report
    }
    for (const entry of entries) {
      const childRel = rel ? path.join(rel, entry.name) : entry.name
      if (entry.isDirectory()) {
        if (!SKIP_DIRS.has(entry.name)) walk(childRel)
      } else if (isEnvFileName(entry.name)) {
        found.push(childRel)
      }
    }
  }
  walk('')
  return found.sort()
}

/**
 * Decide what to do about one destination path.
 *
 * `link` and `copy` are the work; `current` means the link already points at
 * the source; `blocked` means a real file is sitting there and only --force
 * may replace it -- a worktree that deliberately carries its own `.env` must
 * not have it silently swapped for the shared one.
 */
export function planAction(dest, absoluteTarget, { mode, force }) {
  let stat = null
  try {
    stat = lstatSync(dest)
  } catch {
    return mode === 'copy' ? 'copy' : 'link'
  }
  if (stat.isSymbolicLink()) {
    if (mode === 'copy') return 'copy'
    let target = ''
    try {
      target = readlinkSync(dest)
    } catch {
      return 'link'
    }
    return path.resolve(path.dirname(dest), target) === absoluteTarget ? 'current' : 'link'
  }
  return force ? (mode === 'copy' ? 'copy' : 'link') : 'blocked'
}

function git(args, cwd) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
}

/** Repo-relative paths from `candidates` that git actually ignores in `root`. */
export function filterIgnored(root, candidates, { run = git } = {}) {
  if (candidates.length === 0) return []
  try {
    const out = run(['check-ignore', '--', ...candidates], root)
    const ignored = new Set(out.split('\n').filter(Boolean))
    return candidates.filter((rel) => ignored.has(rel))
  } catch {
    // `git check-ignore` exits 1 when nothing matches, which execFileSync
    // throws on. Nothing ignored means nothing to link.
    return []
  }
}

/**
 * The worktree that owns the secrets: MEMRY_ENV_SOURCE when set, otherwise the
 * main worktree, which `git worktree list --porcelain` always prints first.
 */
export function resolveSource(cwd, { env = process.env, run = git } = {}) {
  if (env.MEMRY_ENV_SOURCE) return path.resolve(env.MEMRY_ENV_SOURCE)
  const first = run(['worktree', 'list', '--porcelain'], cwd).split('\n')[0] ?? ''
  const match = /^worktree (.+)$/.exec(first.trim())
  if (!match) throw new Error('could not determine the main worktree')
  return match[1]
}

function main() {
  const argv = process.argv.slice(2)
  const mode = argv.includes('--copy') ? 'copy' : 'link'
  const check = argv.includes('--check')
  const force = argv.includes('--force')
  const quiet = argv.includes('--quiet')
  const say = (message) => {
    if (!quiet) console.log(message)
  }

  // CI checks out a single tree and injects secrets through the runner; there
  // is no main worktree to borrow from and a hard failure here would break
  // every install job.
  if (process.env.CI && !process.env.MEMRY_ENV_SOURCE) return

  let target
  try {
    target = git(['rev-parse', '--show-toplevel'], process.cwd()).trim()
  } catch {
    return // not a git repo (a tarball install, say): nothing to link
  }

  let source
  try {
    source = resolveSource(target)
  } catch {
    say('link-env: could not locate the source worktree, skipping')
    return
  }

  if (path.resolve(source) === path.resolve(target)) {
    say('link-env: already in the source worktree, nothing to do')
    return
  }
  if (!existsSync(source)) {
    say(`link-env: source ${source} does not exist, skipping`)
    return
  }

  const files = filterIgnored(source, findEnvFiles(source))
  const dirs = filterIgnored(source, findSharedDirs(source))
  const entries = [
    ...files.map((rel) => ({ rel, isDir: false })),
    ...dirs.map((rel) => ({ rel, isDir: true }))
  ]
  if (entries.length === 0) {
    say('link-env: no gitignored env files or state found in the source worktree')
    return
  }

  const results = { linked: 0, copied: 0, current: 0, blocked: [], missing: [], skipped: [] }

  for (const { rel, isDir } of entries) {
    const absoluteTarget = path.join(source, rel)
    const dest = path.join(target, rel)
    const action = planAction(dest, absoluteTarget, { mode, force })

    if (action === 'current') {
      results.current += 1
      continue
    }
    if (action === 'blocked') {
      results.blocked.push(rel)
      continue
    }
    // Never conjure the parent directory of an env file. `apps/mobile/ios/.xcode.env`
    // lives in `expo prebuild` output, and materialising an `ios/` folder just to
    // hold a symlink makes prebuild think the project is already ejected. A shared
    // state directory has no such trap: its parent is wrangler's own gitignored
    // `.wrangler`, which wrangler would create itself on the next dev run.
    if (!existsSync(path.dirname(dest))) {
      if (!isDir) {
        results.skipped.push(rel)
        continue
      }
      if (!check) mkdirSync(path.dirname(dest), { recursive: true })
    }
    if (check) {
      results.missing.push(rel)
      continue
    }

    rmSync(dest, { force: true, recursive: isDir })
    if (action === 'copy') {
      if (isDir) cpSync(absoluteTarget, dest, { recursive: true })
      else copyFileSync(absoluteTarget, dest)
      results.copied += 1
    } else {
      symlinkSync(absoluteTarget, dest, isDir ? 'dir' : 'file')
      results.linked += 1
    }
  }

  const done = results.linked + results.copied
  if (check) {
    for (const rel of results.missing) console.log(`link-env: missing ${rel}`)
    for (const rel of results.blocked) console.log(`link-env: not a link ${rel}`)
    if (results.missing.length > 0) {
      console.error(`link-env: ${results.missing.length} item(s) missing -- run \`pnpm env:link\``)
      process.exit(1)
    }
    say(`link-env: ${results.current} item(s) in place`)
    return
  }

  if (done > 0) {
    say(
      `link-env: ${mode === 'copy' ? 'copied' : 'linked'} ${done} item(s) from ${source}` +
        (results.current > 0 ? ` (${results.current} already in place)` : '')
    )
  } else {
    say(`link-env: ${results.current} item(s) already in place`)
  }
  for (const rel of results.blocked) {
    say(`link-env: kept the existing ${rel} (pass --force to replace it)`)
  }
  for (const rel of results.skipped) {
    say(`link-env: skipped ${rel} (${path.dirname(rel)} does not exist here)`)
  }
}

// Only run when invoked directly, so the helpers above stay unit-testable.
if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname)
) {
  main()
}
