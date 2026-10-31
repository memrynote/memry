import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import {
  chmodSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'

const prePushPath = new URL('../.husky/pre-push', import.meta.url).pathname
const prePush = readFileSync(prePushPath, 'utf8')
const scriptsDir = new URL('.', import.meta.url).pathname

// Fake pnpm: `docs:impact --base <sha>` passes only when <sha>...HEAD touches apps/docs.
const fakePnpm = `#!/bin/sh
[ "$1" = "docs:impact" ] || exit 2
git diff --name-only "$3"...HEAD | grep -q '^apps/docs/' && exit 0
exit 1
`

function makeFixture() {
  const root = mkdtempSync(join(tmpdir(), 'pre-push-'))
  const repo = join(root, 'repo')
  const bin = join(root, 'bin')
  mkdirSync(bin)
  writeFileSync(join(bin, 'pnpm'), fakePnpm)
  chmodSync(join(bin, 'pnpm'), 0o755)
  const hooks = join(root, 'hooks')
  mkdirSync(hooks)
  writeFileSync(join(hooks, 'pre-push'), prePush)
  chmodSync(join(hooks, 'pre-push'), 0o755)
  const origin = join(root, 'origin.git')
  const git = (...args) => execFileSync('git', args, { cwd: repo, stdio: 'pipe' })
  const env = { ...process.env, PATH: `${bin}:${process.env.PATH}`, MEMRY_DOCS_IMPACT_SKIP: '' }
  // Name the branch: CI runners default to master, which leaves clones of origin unborn.
  execFileSync('git', ['init', '-q', '--bare', '-b', 'main', origin])
  execFileSync('git', ['clone', '-q', join(root, 'origin.git'), repo], { stdio: 'pipe' })
  git('config', 'user.email', 't@t')
  git('config', 'user.name', 't')
  // The hook runs `node scripts/...` from the repo root; point that at this checkout's scripts.
  symlinkSync(scriptsDir, join(repo, 'scripts'))
  writeFileSync(join(repo, '.git/info/exclude'), 'scripts\n')
  const commit = (path, body) => {
    mkdirSync(join(repo, path, '..'), { recursive: true })
    writeFileSync(join(repo, path), body)
    git('add', path)
    git('commit', '-q', '-m', path)
  }
  commit('README.md', 'base\n')
  // The format check reads the oxfmt config at the pushed commit, as in the real repo.
  commit('.oxfmtrc.jsonc', readFileSync(new URL('../.oxfmtrc.jsonc', import.meta.url)))
  git('push', '-q', 'origin', 'HEAD:main')
  git('fetch', '-q', 'origin')
  git('checkout', '-q', '-b', 'docs-gate-fixture', 'origin/main')
  const runHook = () => spawnSync('sh', [prePushPath], { cwd: repo, encoding: 'utf8', env })
  // A real `git push` with the hook installed, so it reads the ref lines git writes to stdin.
  const push = (...args) =>
    spawnSync('git', ['-c', `core.hooksPath=${hooks}`, 'push', '-q', 'origin', ...args], {
      cwd: repo,
      encoding: 'utf8',
      env
    })
  const remoteRef = (ref) =>
    spawnSync('git', ['--git-dir', origin, 'rev-parse', '--verify', '--quiet', ref], {
      encoding: 'utf8'
    }).stdout.trim()
  return { root, repo, origin, git, commit, runHook, push, remoteRef }
}

function withFixture(test) {
  const fx = makeFixture()
  try {
    test(fx)
  } finally {
    rmSync(fx.root, { recursive: true, force: true })
  }
}

describe('pre-push hook policy', () => {
  it('leaves lint, typecheck, and test suites to GitHub Actions', () => {
    assert.doesNotMatch(prePush, /MEMRY_HOOK_STRICT/)

    for (const command of [
      'pnpm repair:links',
      'pnpm check:contracts',
      'pnpm check:architecture',
      'pnpm typecheck:packages',
      'pnpm lint',
      'pnpm ipc:check',
      'pnpm typecheck:desktop',
      'pnpm test:desktop',
      'pnpm typecheck:sync-server',
      'pnpm test:sync-server'
    ]) {
      assert.doesNotMatch(prePush, new RegExp(command.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
    }
  })

  it('keeps docs AI updates opt-in instead of running them on every push', () => {
    assert.match(prePush, /MEMRY_DOCS_AI_AUTO:-0/)

    const docsAutoStart = prePush.indexOf('MEMRY_DOCS_AI_AUTO:-0')
    const docsUpdaterCommand = prePush.indexOf('pnpm docs:ai-update --base "$base_commit"')
    assert.notEqual(docsAutoStart, -1)
    assert.notEqual(docsUpdaterCommand, -1)
    assert.ok(docsUpdaterCommand > docsAutoStart)
  })

  it('keeps the docs impact gate in the pre-push hook', () => {
    assert.match(prePush, /pnpm docs:impact --base "\$base_commit" --strict/)
    assert.doesNotMatch(prePush, /pnpm docs:build/)
  })

  it('diffs the whole branch against origin/main, not the last pushed commit', () => {
    const fx = makeFixture()
    try {
      fx.commit('apps/desktop/src/feature.ts', 'export const a = 1\n')
      fx.commit('apps/docs/src/feature.md', '# Feature\n')
      assert.equal(fx.runHook().status, 0)
      fx.git('push', '-q', '-u', 'origin', 'HEAD')

      fx.commit('apps/desktop/src/feature.ts', '// comment\nexport const a = 1\n')
      const second = fx.runHook()
      assert.equal(second.status, 0, second.stderr)
    } finally {
      rmSync(fx.root, { recursive: true, force: true })
    }
  })

  it('still fails a branch that changes code without docs anywhere', () => {
    const fx = makeFixture()
    try {
      fx.commit('apps/desktop/src/feature.ts', 'export const a = 1\n')
      fx.git('push', '-q', '-u', 'origin', 'HEAD')
      fx.commit('apps/desktop/src/feature.ts', 'export const a = 2\n')
      assert.equal(fx.runHook().status, 1)
    } finally {
      rmSync(fx.root, { recursive: true, force: true })
    }
  })
})

describe('pre-push hook force-push refusal', () => {
  it('allows a fast-forward push', () =>
    withFixture((fx) => {
      fx.commit('README.md', 'next\n')
      const result = fx.push('HEAD:main')
      assert.equal(result.status, 0, result.stderr)
      assert.equal(fx.remoteRef('main'), fx.git('rev-parse', 'HEAD').toString().trim())
    }))

  it('allows pushing a new branch', () =>
    withFixture((fx) => {
      fx.commit('README.md', 'next\n')
      const result = fx.push('HEAD:refs/heads/feature')
      assert.equal(result.status, 0, result.stderr)
      assert.equal(fx.remoteRef('feature'), fx.git('rev-parse', 'HEAD').toString().trim())
    }))

  it('allows deleting a remote branch', () =>
    withFixture((fx) => {
      fx.git('push', '-q', 'origin', 'HEAD:refs/heads/feature')
      const result = fx.push('--delete', 'feature')
      assert.equal(result.status, 0, result.stderr)
      assert.equal(fx.remoteRef('feature'), '')
    }))

  it('refuses a non-fast-forward push, with or without a lease', () =>
    withFixture((fx) => {
      fx.commit('README.md', 'pushed\n')
      fx.git('push', '-q', 'origin', 'HEAD:main')
      const pushed = fx.remoteRef('main')
      fx.git('reset', '-q', '--soft', 'HEAD~1')
      fx.git('commit', '-q', '-m', 'rewritten')

      for (const flag of ['--force', '--force-with-lease']) {
        const result = fx.push(flag, 'HEAD:main')
        assert.equal(result.status, 1, `${flag} was not refused`)
        assert.match(result.stderr, /refusing to push refs\/heads\/main/)
        assert.match(
          result.stderr,
          /Merge the base into your branch instead of rebasing a pushed branch/
        )
        assert.equal(fx.remoteRef('main'), pushed)
      }
    }))

  it('refuses the whole push when one of several refs is forced', () =>
    withFixture((fx) => {
      fx.commit('README.md', 'pushed\n')
      fx.git('push', '-q', 'origin', 'HEAD:main')
      const pushed = fx.remoteRef('main')
      fx.git('reset', '-q', '--soft', 'HEAD~1')
      fx.git('commit', '-q', '-m', 'rewritten')

      const result = fx.push('HEAD:refs/heads/feature', '+HEAD:main')
      assert.equal(result.status, 1)
      assert.match(result.stderr, /refusing to push refs\/heads\/main/)
      assert.equal(fx.remoteRef('main'), pushed)
      assert.equal(fx.remoteRef('feature'), '')
    }))

  it('refuses moving a tag that exists on the remote, even forward', () =>
    withFixture((fx) => {
      fx.git('tag', 'v1')
      fx.git('push', '-q', 'origin', 'refs/tags/v1')
      const pushed = fx.remoteRef('refs/tags/v1')
      fx.commit('README.md', 'next\n')
      fx.git('tag', '-f', 'v1')

      const moved = fx.push('--force', 'refs/tags/v1')
      assert.equal(moved.status, 1)
      assert.match(moved.stderr, /refusing to push refs\/tags\/v1: the tag already exists/)
      assert.equal(fx.remoteRef('refs/tags/v1'), pushed)

      fx.git('tag', 'v2')
      const fresh = fx.push('refs/tags/v2')
      assert.equal(fresh.status, 0, fresh.stderr)
    }))

  it('still runs the branch-name check after reading the pushed refs', () =>
    withFixture((fx) => {
      fx.git('checkout', '-q', '-b', 'claude/fixture')
      const result = fx.push('HEAD:refs/heads/claude/fixture')
      assert.equal(result.status, 1)
      assert.match(result.stderr, /rename tool-branded\/random branch before pushing/)
      assert.equal(fx.remoteRef('claude/fixture'), '')
    }))

  it('still runs the docs gate after reading the pushed refs', () =>
    withFixture((fx) => {
      fx.commit('apps/desktop/src/feature.ts', 'export const a = 1\n')
      const withoutDocs = fx.push('HEAD:refs/heads/feature')
      assert.equal(withoutDocs.status, 1)
      assert.match(withoutDocs.stderr, /docs update required/)

      fx.commit('apps/docs/src/feature.md', '# Feature\n')
      const withDocs = fx.push('HEAD:refs/heads/feature')
      assert.equal(withDocs.status, 0, withDocs.stderr)
    }))

  it('refuses a push over a remote commit this clone has not fetched', () =>
    withFixture((fx) => {
      const other = join(fx.root, 'other')
      execFileSync('git', ['clone', '-q', '-b', 'main', fx.origin, other], { stdio: 'pipe' })
      writeFileSync(join(other, 'README.md'), 'theirs\n')
      execFileSync(
        'git',
        ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qam', 'theirs'],
        {
          cwd: other,
          stdio: 'pipe'
        }
      )
      execFileSync('git', ['push', '-q', 'origin', 'HEAD:main'], { cwd: other, stdio: 'pipe' })
      const theirs = fx.remoteRef('main')

      fx.commit('README.md', 'ours\n')
      const result = fx.push('--force', 'HEAD:main')
      assert.equal(result.status, 1)
      assert.match(
        result.stderr,
        /refusing to push refs\/heads\/main: the remote has commits you don't have: fetch and merge them/
      )
      assert.doesNotMatch(result.stderr, /rebasing/)
      assert.equal(fx.remoteRef('main'), theirs)
    }))
})

describe('pre-push hook re-runs pre-commit checks over the pushed commits', () => {
  // Fixture commits run no hooks, as `git commit --no-verify` does. Paths sit under tools/,
  // which the docs gate ignores, so a refusal here comes from the range checks.
  // Assembled at runtime so this file does not trip the scanner (check-staged-secrets.test.mjs).
  const leakedToken = `export const token = '${['ghp', 'abc123def456ghi789jkl012'].join('_')}'\n`
  const unformatted = 'export const a = "x";\n'

  it('passes a clean range on a new branch and on an update', () =>
    withFixture((fx) => {
      fx.commit('tools/a.ts', "export const a = 'x'\n")
      const created = fx.push('HEAD:refs/heads/feature')
      assert.equal(created.status, 0, created.stderr)
      fx.commit('tools/b.ts', "export const b = 'y'\n")
      const updated = fx.push('HEAD:refs/heads/feature')
      assert.equal(updated.status, 0, updated.stderr)
    }))

  it('refuses a new branch whose commit holds a secret', () =>
    withFixture((fx) => {
      fx.commit('tools/config.ts', leakedToken)
      const result = fx.push('HEAD:refs/heads/feature')
      assert.equal(result.status, 1)
      assert.match(result.stderr, /secret scan: potential secrets detected in the pushed commits/)
      assert.match(result.stderr, /tools\/config\.ts:1 github-token/)
      assert.equal(fx.remoteRef('feature'), '')
    }))

  it('refuses an update whose new commit holds an unformatted file', () =>
    withFixture((fx) => {
      fx.commit('tools/a.ts', "export const a = 'x'\n")
      assert.equal(fx.push('HEAD:refs/heads/feature').status, 0)
      const pushed = fx.remoteRef('feature')
      fx.commit('tools/b.ts', unformatted)
      const result = fx.push('HEAD:refs/heads/feature')
      assert.equal(result.status, 1)
      assert.match(result.stdout + result.stderr, /tools\/b\.ts/)
      assert.match(result.stderr, /format check: files in the pushed commits/)
      assert.equal(fx.remoteRef('feature'), pushed)
    }))

  it('checks the pushed commit, not the working tree', () =>
    withFixture((fx) => {
      fx.commit('tools/b.ts', unformatted)
      writeFileSync(join(fx.repo, 'tools/b.ts'), "export const a = 'x'\n")
      assert.equal(fx.push('HEAD:refs/heads/feature').status, 1)
    }))

  it('skips files the push deletes and files only the merged base changed', () =>
    withFixture((fx) => {
      // Someone else's hookless push leaves an unformatted file on main.
      fx.git('checkout', '-q', 'main')
      fx.commit('tools/theirs.ts', unformatted)
      fx.git('push', '-q', 'origin', 'HEAD:main')
      fx.git('checkout', '-q', 'docs-gate-fixture')
      fx.commit('tools/gone.ts', unformatted)
      fx.git('rm', '-q', 'tools/gone.ts')
      fx.git('commit', '-q', '-m', 'remove')
      fx.git('merge', '-q', '--no-edit', 'origin/main')
      const result = fx.push('HEAD:refs/heads/feature')
      assert.equal(result.status, 0, result.stderr)
    }))
})
