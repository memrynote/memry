#!/usr/bin/env node

// Usage: node scripts/check-pushed-format.mjs <local-sha> <remote-sha>
//
// The pre-push hook re-runs the format check over the files a push adds, because
// `git commit --no-verify` skips the oxfmt pass of pre-commit's lint-staged. It checks the
// content at the pushed commit, not the working tree: the files are written to a temporary
// snapshot with the commit's oxfmt config and ignore files, and oxfmt checks the snapshot, so
// the config's ignorePatterns and oxfmt's own file-type support decide what is checked, as in
// `pnpm format:check`.

import { execFileSync, spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

import { listPushedFiles, readFileAt } from './pushed-files.mjs'

const [localSha, remoteSha] = process.argv.slice(2)

if (!remoteSha) {
  console.error('Usage: node scripts/check-pushed-format.mjs <local-sha> <remote-sha>')
  process.exit(2)
}

const files = listPushedFiles(localSha, remoteSha)

if (files.length > 0) {
  const configFiles = execFileSync(
    'git',
    [
      'ls-tree',
      '-z',
      '--name-only',
      localSha,
      '--',
      '.oxfmtrc.jsonc',
      '.gitignore',
      '.editorconfig'
    ],
    { encoding: 'utf8' }
  )
    .split('\0')
    .filter(Boolean)
  const oxfmt = join(
    dirname(createRequire(import.meta.url).resolve('oxfmt/package.json')),
    'bin/oxfmt'
  )
  const snapshot = mkdtempSync(join(tmpdir(), 'memry-pushed-format-'))

  try {
    for (const filePath of new Set([...configFiles, ...files])) {
      mkdirSync(dirname(join(snapshot, filePath)), { recursive: true })
      writeFileSync(join(snapshot, filePath), readFileAt(localSha, filePath))
    }

    const result = spawnSync(
      process.execPath,
      [oxfmt, '--check', '--no-error-on-unmatched-pattern'],
      { cwd: snapshot, encoding: 'utf8' }
    )

    if (result.status !== 0) {
      process.stderr.write(result.stdout + result.stderr)
      console.error(
        `\nformat check: files in the pushed commits (${localSha}) are not formatted. Run \`pnpm exec oxfmt <file>\`, commit, and push again.\n`
      )
      process.exit(1)
    }
  } finally {
    rmSync(snapshot, { recursive: true, force: true })
  }
}
