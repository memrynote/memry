import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { after, before, describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'

import { isStrictSkipEnabled } from './docs-impact.mjs'

const scriptPath = fileURLToPath(new URL('./docs-impact.mjs', import.meta.url))

let repo
let baseCommit

function git(args) {
  return execFileSync('git', ['-c', 'core.hooksPath=', ...args], {
    cwd: repo,
    encoding: 'utf8'
  }).trim()
}

function writeRepoFile(relativePath, contents) {
  const target = path.join(repo, relativePath)
  mkdirSync(path.dirname(target), { recursive: true })
  writeFileSync(target, contents)
}

function commit(message) {
  git(['add', '-A'])
  git(['-c', 'user.email=test@memry.local', '-c', 'user.name=Memry Test', 'commit', '-m', message])
  return git(['rev-parse', 'HEAD'])
}

function runGate(env = {}) {
  return spawnSync(process.execPath, [scriptPath, '--base', baseCommit, '--strict'], {
    cwd: repo,
    encoding: 'utf8',
    env: { ...process.env, MEMRY_DOCS_IMPACT_SKIP: '', ...env }
  })
}

before(() => {
  repo = mkdtempSync(path.join(tmpdir(), 'docs-impact-'))
  git(['init', '--quiet'])
  writeRepoFile('README.md', '# base\n')
  baseCommit = commit('base')
})

after(() => {
  rmSync(repo, { force: true, recursive: true })
})

describe('isStrictSkipEnabled', () => {
  it('only opts out on an exact "1"', () => {
    assert.equal(isStrictSkipEnabled({ MEMRY_DOCS_IMPACT_SKIP: '1' }), true)
    assert.equal(isStrictSkipEnabled({ MEMRY_DOCS_IMPACT_SKIP: '0' }), false)
    assert.equal(isStrictSkipEnabled({ MEMRY_DOCS_IMPACT_SKIP: 'true' }), false)
    assert.equal(isStrictSkipEnabled({}), false)
  })
})

describe('docs:impact --strict', () => {
  it('fails an undocumented desktop change when the flag is unset', () => {
    writeRepoFile('apps/desktop/src/feature.ts', 'export const feature = 1\n')
    commit('add desktop feature')

    const unset = runGate()
    assert.equal(unset.status, 1)
    assert.match(unset.stderr, /desktop\/sync-server changes need docs review/)
    assert.match(unset.stderr, /MEMRY_DOCS_IMPACT_SKIP=1/)

    const explicitZero = runGate({ MEMRY_DOCS_IMPACT_SKIP: '0' })
    assert.equal(explicitZero.status, 1)
  })

  it('passes the same change when MEMRY_DOCS_IMPACT_SKIP=1 and names the waived files', () => {
    const skipped = runGate({ MEMRY_DOCS_IMPACT_SKIP: '1' })

    assert.equal(skipped.status, 0)
    assert.match(skipped.stderr, /bypassed via MEMRY_DOCS_IMPACT_SKIP=1/)
    assert.match(skipped.stderr, /apps\/desktop\/src\/feature\.ts/)
  })

  it('leaves stdout parseable as JSON while bypassing', () => {
    const skipped = spawnSync(
      process.execPath,
      [scriptPath, '--base', baseCommit, '--strict', '--json'],
      {
        cwd: repo,
        encoding: 'utf8',
        env: { ...process.env, MEMRY_DOCS_IMPACT_SKIP: '1' }
      }
    )

    assert.equal(skipped.status, 0)
    assert.equal(JSON.parse(skipped.stdout).status, 'missing-docs')
  })

  it('still passes without the flag once docs cover the change', () => {
    writeRepoFile('apps/docs/src/user-guide/feature.md', '# Feature\n')
    commit('document desktop feature')

    const covered = runGate()
    assert.equal(covered.status, 0)
  })
})
