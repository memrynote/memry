#!/usr/bin/env node

// Usage: node scripts/check-pushed.mjs <remote> <local-sha> <remote-sha>
//
// `git commit --no-verify` skips pre-commit, so the pre-push hook runs this once per pushed ref.
// It re-runs pre-commit's secret scan (the scanner's own rules) and checks the format with oxfmt
// over the files the push adds or changes, as they are in the pushed commit, not the working tree.

import { execFileSync, spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

import { binaryPathPattern, scanTextForSecrets } from './check-staged-secrets.mjs'

// A first push to a URL has no remote-tracking refs to leave out, so it reads every text file.
const maxBuffer = 1024 * 1024 * 1024

// oxfmt reads its config and ignore files from the directory it runs in.
const formatConfigPaths = new Set(['.oxfmtrc.jsonc', '.gitignore', '.editorconfig'])

function git(args, input) {
  return execFileSync('git', args, { input, maxBuffer })
}

/**
 * Paths touched by the commits the push adds: reachable from `localSha` and not from `remoteSha`
 * (all zeros for a new ref) nor from any of the remote's tracking refs. Leaving out the remote's
 * refs keeps a merged base branch out, so a push that merges origin/feat/tauri-v2 checks only the
 * branch's own changes. A push to a URL has no tracking refs, so only `remoteSha` is left out.
 * A merge lists the paths whose result differs from every parent: what a conflict resolution or
 * an edit made during the merge writes.
 */
function touchedPaths(remote, localSha, remoteSha) {
  const isNamedRemote = git(['remote']).toString().split('\n').includes(remote)
  const output = git([
    'log',
    '-z',
    '--format=',
    '--name-only',
    '--no-renames',
    '--diff-merges=combined',
    '--diff-filter=d',
    localSha,
    '--not',
    ...(/^0+$/.test(remoteSha) ? [] : [remoteSha]),
    ...(isNamedRemote ? [`--remotes=${remote}/*`] : [])
  ])
  return new Set(output.toString().split('\0').filter(Boolean))
}

/** The regular files at `localSha` that `include` keeps, read with one `git cat-file --batch`. */
function readFiles(localSha, include) {
  const entries = git(['ls-tree', '-r', '-z', localSha])
    .toString()
    .split('\0')
    .map((entry) => entry.match(/^100\d{3} blob (\S+)\t(.*)$/s))
    .filter((match) => match && include(match[2]))
    .map(([, blob, path]) => ({ blob, path }))

  if (entries.length === 0) {
    return []
  }

  const output = git(['cat-file', '--batch'], entries.map(({ blob }) => `${blob}\n`).join(''))
  let offset = 0
  return entries.map(({ path }) => {
    // Each object is "<id> blob <size>\n<content>\n".
    const headerEnd = output.indexOf(10, offset)
    const size = Number(output.toString('utf8', offset, headerEnd).split(' ')[2])
    const content = output.subarray(headerEnd + 1, headerEnd + 1 + size)
    offset = headerEnd + 1 + size + 1
    return { path, content }
  })
}

/** Paths oxfmt would change, checked in a snapshot of `files` taken at the pushed commit. */
function listUnformatted(files) {
  let oxfmt
  try {
    oxfmt = join(dirname(createRequire(import.meta.url).resolve('oxfmt/package.json')), 'bin/oxfmt')
  } catch (cause) {
    throw new Error('oxfmt is not installed. Run `pnpm install`, then push again.', { cause })
  }

  const snapshot = mkdtempSync(join(tmpdir(), 'memry-pushed-'))
  try {
    for (const { path, content } of files) {
      mkdirSync(dirname(join(snapshot, path)), { recursive: true })
      writeFileSync(join(snapshot, path), content)
    }

    const result = spawnSync(
      process.execPath,
      [oxfmt, '--list-different', '--no-error-on-unmatched-pattern'],
      { cwd: snapshot, encoding: 'utf8', maxBuffer }
    )
    const listed = (result.stdout ?? '').split('\n').filter(Boolean)

    // --list-different exits 1 with the files listed; any other failure lists nothing.
    if (result.error || (result.status !== 0 && listed.length === 0)) {
      const reason = result.error?.message ?? `${result.status}: ${result.stderr.trim()}`
      throw new Error(
        `oxfmt failed (${reason}). Check .oxfmtrc.jsonc in the pushed commit, run \`pnpm install\`, then push again.`
      )
    }

    return listed
  } finally {
    rmSync(snapshot, { recursive: true, force: true })
  }
}

function main(remote, localSha, remoteSha) {
  const touched = touchedPaths(remote, localSha, remoteSha)

  if (touched.size === 0) {
    return true
  }

  // Media files hold no secret the scanner reads and nothing oxfmt formats.
  const files = readFiles(
    localSha,
    (path) => (touched.has(path) || formatConfigPaths.has(path)) && !binaryPathPattern.test(path)
  )
  const secrets = files
    .filter(({ path, content }) => touched.has(path) && !content.includes(0))
    .flatMap(({ path, content }) => scanTextForSecrets(path, content.toString('utf8')))
  const unformatted = listUnformatted(files)

  if (secrets.length > 0) {
    console.error(
      `\nsecret scan: potential secrets detected in the pushed commits (${localSha}):\n`
    )
    for (const finding of secrets) {
      console.error(`  ${finding.filePath}:${finding.line} ${finding.rule} - ${finding.message}`)
    }
    console.error('\nUse placeholders in examples and keep real secrets in ignored local files.\n')
  }

  if (unformatted.length > 0) {
    console.error(`\nformat check: files in the pushed commits (${localSha}) are not formatted:\n`)
    for (const path of unformatted) {
      console.error(`  ${path}`)
    }
    console.error('\nRun `pnpm exec oxfmt <file>`, commit, and push again.\n')
  }

  return secrets.length === 0 && unformatted.length === 0
}

const [remote, localSha, remoteSha] = process.argv.slice(2)

if (!remoteSha) {
  console.error('Usage: node scripts/check-pushed.mjs <remote> <local-sha> <remote-sha>')
  process.exit(2)
}

try {
  if (!main(remote, localSha, remoteSha)) {
    process.exit(1)
  }
} catch (error) {
  console.error(
    `\npre-push: the secret and format checks could not run on ${localSha}: ${error.message}\n`
  )
  process.exit(1)
}
