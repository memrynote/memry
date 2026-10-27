#!/usr/bin/env node
// Builds the real Electron code of a production tag with only the update feed changed.
// Usage: node scripts/rehearsal/build-electron-rehearsal.mjs <tag> <feed_repo> [--keep]
//
// The feed is fixed at build time and never edited in an installed app. Two constants are
// replaced in a git worktree of the tag, and electron-builder gets a publish override that writes
// `resources/app-update.yml` with the rehearsal repo. The main tree is never edited.
import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const FEED_FILES = [
  {
    constant: 'VELOPACK_FEED_URL',
    file: 'apps/desktop/src/main/updater-backend-velopack.ts',
    pattern: /^(\s*(?:export\s+)?const VELOPACK_FEED_URL\s*=\s*)(['"`]).*?\2/m
  },
  {
    constant: 'GITHUB_RELEASE_DOWNLOAD_BASE',
    file: 'apps/desktop/src/main/installer-handoff-script.ts',
    pattern: /^(\s*(?:export\s+)?const GITHUB_RELEASE_DOWNLOAD_BASE\s*=\s*)(['"`]).*?\2/m
  }
]

const RESOURCES_TAG = 'v2026-10-15'

// Each platform runs the commands of its production release job; the publish overrides go to the
// last one, which runs electron-builder. Windows cannot use `build:win`: its `prebuild` runs
// ensure-native.sh under Git bash, whose /d/a/... paths node cannot resolve (run 40388750063).
// publish-release.yml builds Windows with `build:release` and `build-packaged-app.js --win --x64`,
// which rebuilds the native modules itself.
const PRODUCTION_BUILD = {
  darwin: [['pnpm', ['--filter', '@memry/desktop', 'build:mac']]],
  win32: [
    ['pnpm', ['--filter', '@memry/desktop', 'build:release']],
    ['node', ['apps/desktop/scripts/build-packaged-app.js', '--win', '--x64']]
  ],
  linux: [['pnpm', ['--filter', '@memry/desktop', 'build:linux']]]
}

/** Rewrites one constant in `source`; throws when nothing changed. */
export function patchConstant(source, { constant, pattern }, value) {
  const patched = source.replace(pattern, `$1$2${value}$2`)
  if (patched === source) {
    throw new Error(`${constant} was not replaced (missing or already ${value})`)
  }
  return patched
}

export function feedValues(feedRepo) {
  const [owner, name] = feedRepo.split('/')
  if (!owner || !name) {
    throw new Error(`feed_repo must be <owner>/<name>, got "${feedRepo}"`)
  }
  return {
    VELOPACK_FEED_URL: `https://github.com/${feedRepo}`,
    GITHUB_RELEASE_DOWNLOAD_BASE: `https://github.com/${feedRepo}/releases/download`
  }
}

export function publishOverrides(feedRepo) {
  const [owner, name] = feedRepo.split('/')
  // `--publish never` writes app-update.yml for the rehearsal repo without uploading anything.
  return [
    '--publish',
    'never',
    '-c.publish.provider=github',
    `-c.publish.owner=${owner}`,
    `-c.publish.repo=${name}`
  ]
}

function run(command, args, options = {}) {
  console.log(`$ ${command} ${args.join(' ')}`)
  const result = spawnSync(command, args, {
    stdio: 'inherit',
    // pnpm is a .cmd shim on Windows.
    shell: process.platform === 'win32',
    ...options
  })
  if (result.status !== 0) {
    throw new Error(`${command} ${args[0] ?? ''} exited with ${result.status}`)
  }
}

export function build({ tag, feedRepo, keep = false, repoRoot = process.cwd() }) {
  const values = feedValues(feedRepo)
  const worktree = path.join(repoRoot, '.worktrees', `electron-rehearsal-${tag}`)
  const productionBuild = PRODUCTION_BUILD[process.platform]
  if (!productionBuild) {
    throw new Error(`Unsupported platform ${process.platform}`)
  }

  run('git', ['worktree', 'add', '--detach', worktree, tag], { cwd: repoRoot })
  try {
    for (const entry of FEED_FILES) {
      const file = path.join(worktree, entry.file)
      if (!existsSync(file)) {
        console.log(`skip ${entry.constant}: ${entry.file} does not exist at ${tag}`)
        continue
      }
      writeFileSync(file, patchConstant(readFileSync(file, 'utf8'), entry, values[entry.constant]))
      console.log(`patched ${entry.constant} in ${entry.file}`)
    }
    // v2026.4.28 tracks no apps/desktop/build (the root .gitignore ignores `build`), so
    // build-packaged-app.js cannot stage it. The directory holds icons, entitlements and the NSIS
    // include only; take it from a later tag. Application code stays the tag's own.
    const buildResources = path.join(worktree, 'apps/desktop/build')
    if (!existsSync(buildResources)) {
      console.log(`apps/desktop/build is missing at ${tag}; restoring it from ${RESOURCES_TAG}`)
      run('git', ['checkout', RESOURCES_TAG, '--', 'apps/desktop/build'], { cwd: worktree })
    }
    // The production build requires a runtime env file whose sync host has certificate pins.
    // Rehearsal installs never sign in, so the shipped default host is only a build input.
    const envFile = path.join(worktree, 'apps/desktop/.env.production')
    if (!existsSync(envFile)) {
      writeFileSync(envFile, 'SYNC_SERVER_URL=https://sync.memrynote.com\n')
    }
    run('pnpm', ['install', '--frozen-lockfile'], { cwd: worktree })
    productionBuild.forEach(([command, args], index) => {
      const last = index === productionBuild.length - 1
      // pnpm appends these to the script's own electron-builder command.
      run(command, last ? [...args, ...publishOverrides(feedRepo)] : args, { cwd: worktree })
    })
    console.log(
      `Electron rehearsal build of ${tag} is in ${path.join(worktree, 'apps/desktop/dist')}`
    )
  } finally {
    if (!keep) {
      run('git', ['worktree', 'remove', '--force', worktree], { cwd: repoRoot })
    }
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [tag, feedRepo, ...flags] = process.argv.slice(2)
  if (!tag || !feedRepo) {
    console.error('usage: build-electron-rehearsal.mjs <tag> <feed_repo> [--keep]')
    process.exit(2)
  }
  build({ tag, feedRepo, keep: flags.includes('--keep') })
}
