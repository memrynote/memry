import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { chmodSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'

const prePushPath = new URL('../.husky/pre-push', import.meta.url).pathname
const prePush = readFileSync(prePushPath, 'utf8')

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
  const git = (...args) => execFileSync('git', args, { cwd: repo, stdio: 'pipe' })
  execFileSync('git', ['init', '-q', '--bare', join(root, 'origin.git')])
  execFileSync('git', ['clone', '-q', join(root, 'origin.git'), repo], { stdio: 'pipe' })
  git('config', 'user.email', 't@t')
  git('config', 'user.name', 't')
  const commit = (path, body) => {
    mkdirSync(join(repo, path, '..'), { recursive: true })
    writeFileSync(join(repo, path), body)
    git('add', path)
    git('commit', '-q', '-m', path)
  }
  commit('README.md', 'base\n')
  git('push', '-q', 'origin', 'HEAD:main')
  git('fetch', '-q', 'origin')
  git('checkout', '-q', '-b', 'docs-gate-fixture', 'origin/main')
  const runHook = () =>
    spawnSync('sh', [prePushPath], {
      cwd: repo,
      encoding: 'utf8',
      env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, MEMRY_DOCS_IMPACT_SKIP: '' }
    })
  return { root, git, commit, runHook }
}

describe('pre-push hook policy', () => {
  it('leaves lint, typecheck, and test suites to GitHub Actions', () => {
    assert.doesNotMatch(prePush, /MEMRY_HOOK_STRICT/)

    for (const command of [
      'pnpm repair:links',
      'pnpm check:contracts',
      'pnpm check:architecture',
      'pnpm typecheck:packages',
      'pnpm lint:desktop',
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
