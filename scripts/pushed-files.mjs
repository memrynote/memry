import { execFileSync } from 'node:child_process'

// Generated sources (the UniFFI Swift bindings) pass 1 MB, execFileSync's default maxBuffer.
const maxBuffer = 64 * 1024 * 1024

function git(args) {
  return execFileSync('git', args, { encoding: 'utf8', maxBuffer })
}

/**
 * The regular files at `localSha` that a push of `localSha` over `remoteSha` adds to the remote:
 * paths touched by the commits reachable from `localSha` and from no remote ref, nor from
 * `remoteSha` (all zeros for a new ref). Leaving out every remote ref, not only `remoteSha`, keeps a
 * merged base branch out of the list, so a push that merges origin/feat/tauri-v2 checks only its
 * own changes. Paths deleted by the push and symlinks are skipped: they hold no content at
 * `localSha`.
 */
export function listPushedFiles(localSha, remoteSha) {
  const exclude = /^0+$/.test(remoteSha) ? [] : [remoteSha]
  const touched = new Set(
    git([
      'log',
      '-z',
      '--format=',
      '--name-only',
      '--no-renames',
      '--diff-filter=ACMR',
      localSha,
      '--not',
      ...exclude,
      '--remotes'
    ])
      .split('\0')
      .map((file) => file.trim())
      .filter(Boolean)
  )

  if (touched.size === 0) {
    return []
  }

  // One `ls-tree` of the whole commit is faster than a lookup per path, and its mode column tells
  // a regular file (100644, 100755) from a symlink or submodule.
  return git(['ls-tree', '-r', '-z', localSha])
    .split('\0')
    .filter(Boolean)
    .map((entry) => entry.match(/^(\d+) \S+ \S+\t(.*)$/s))
    .filter((match) => match && /^100\d{3}$/.test(match[1]) && touched.has(match[2]))
    .map((match) => match[2])
}

/** The bytes of `path` in `commit`. */
export function readFileAt(commit, path) {
  return execFileSync('git', ['cat-file', 'blob', `${commit}:${path}`], { maxBuffer })
}
