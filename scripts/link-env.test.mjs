import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, it } from 'node:test'

import {
  SHARED_DIRS,
  SHARED_FILES,
  filterIgnored,
  findEnvFiles,
  findSharedDirs,
  findSharedFiles,
  isEnvFileName,
  planAction,
  resolveSource
} from './link-env.mjs'

const tmp = () => mkdtempSync(path.join(tmpdir(), 'link-env-'))

describe('isEnvFileName', () => {
  it('accepts the env files this repo actually keeps out of git', () => {
    for (const name of [
      '.env',
      '.env.dev',
      '.env.staging',
      '.env.local',
      '.env.submit',
      '.dev.vars',
      'electron-builder.env',
      '.xcode.env'
    ]) {
      assert.equal(isEnvFileName(name), true, name)
    }
  })

  it('rejects tracked templates and unrelated files', () => {
    for (const name of [
      '.env.example',
      '.dev.vars.example',
      '.env.sample',
      '.env.template',
      'environment.ts',
      'README.md',
      'env'
    ]) {
      assert.equal(isEnvFileName(name), false, name)
    }
  })
})

describe('findEnvFiles', () => {
  it('walks the tree and skips dependency and build output', () => {
    const root = tmp()
    mkdirSync(path.join(root, 'apps/desktop'), { recursive: true })
    mkdirSync(path.join(root, 'node_modules/pkg'), { recursive: true })
    mkdirSync(path.join(root, 'apps/desktop/dist'), { recursive: true })
    writeFileSync(path.join(root, 'apps/desktop/.env.staging'), 'A=1')
    writeFileSync(path.join(root, 'apps/desktop/.env.example'), 'A=')
    writeFileSync(path.join(root, 'node_modules/pkg/.env'), 'A=1')
    writeFileSync(path.join(root, 'apps/desktop/dist/.env'), 'A=1')

    assert.deepEqual(findEnvFiles(root), ['apps/desktop/.env.staging'])
  })
})

describe('planAction', () => {
  it('links when nothing is there', () => {
    const root = tmp()
    assert.equal(
      planAction(path.join(root, '.env'), path.join(root, 'src/.env'), {
        mode: 'link',
        force: false
      }),
      'link'
    )
  })

  it('reports an existing correct link as current', () => {
    const root = tmp()
    const target = path.join(root, 'source.env')
    const dest = path.join(root, '.env')
    writeFileSync(target, 'A=1')
    symlinkSync(target, dest)
    assert.equal(planAction(dest, target, { mode: 'link', force: false }), 'current')
  })

  it('relinks a symlink that points somewhere else', () => {
    const root = tmp()
    const stale = path.join(root, 'stale.env')
    const target = path.join(root, 'source.env')
    const dest = path.join(root, '.env')
    writeFileSync(stale, 'A=0')
    writeFileSync(target, 'A=1')
    symlinkSync(stale, dest)
    assert.equal(planAction(dest, target, { mode: 'link', force: false }), 'link')
  })

  it('refuses to clobber a real file unless forced', () => {
    const root = tmp()
    const target = path.join(root, 'source.env')
    const dest = path.join(root, '.env')
    writeFileSync(target, 'A=1')
    writeFileSync(dest, 'A=local')
    assert.equal(planAction(dest, target, { mode: 'link', force: false }), 'blocked')
    assert.equal(planAction(dest, target, { mode: 'link', force: true }), 'link')
  })

  it('always rewrites in copy mode so the copy cannot go stale', () => {
    const root = tmp()
    const target = path.join(root, 'source.env')
    const dest = path.join(root, '.env')
    writeFileSync(target, 'A=1')
    symlinkSync(target, dest)
    assert.equal(planAction(dest, target, { mode: 'copy', force: false }), 'copy')
  })
})

describe('filterIgnored', () => {
  it('keeps only the paths git reports as ignored', () => {
    const run = () => 'apps/desktop/.env\n'
    assert.deepEqual(filterIgnored('/repo', ['apps/desktop/.env', 'apps/docs/.env'], { run }), [
      'apps/desktop/.env'
    ])
  })

  it('treats the exit-1 "nothing ignored" case as an empty result', () => {
    const run = () => {
      throw new Error('exit 1')
    }
    assert.deepEqual(filterIgnored('/repo', ['apps/desktop/.env'], { run }), [])
  })

  it('does not shell out when there is nothing to check', () => {
    const run = () => assert.fail('git should not run')
    assert.deepEqual(filterIgnored('/repo', [], { run }), [])
  })
})

describe('resolveSource', () => {
  it('prefers an explicit MEMRY_ENV_SOURCE', () => {
    const run = () => assert.fail('git should not run')
    assert.equal(
      resolveSource('/anywhere', { env: { MEMRY_ENV_SOURCE: '/secrets' }, run }),
      '/secrets'
    )
  })

  it('falls back to the main worktree, which git lists first', () => {
    const run = () =>
      [
        'worktree /Users/kaan/workspace/memry',
        'HEAD abc',
        'branch refs/heads/main',
        '',
        'worktree /Users/kaan/workspace/memry/.worktrees/feature',
        'HEAD def',
        ''
      ].join('\n')
    assert.equal(resolveSource('/anywhere', { env: {}, run }), '/Users/kaan/workspace/memry')
  })

  it('throws when git says nothing useful', () => {
    assert.throws(() => resolveSource('/anywhere', { env: {}, run: () => '' }))
  })
})

describe('findSharedDirs', () => {
  it('returns only the state directories that exist in the source', () => {
    const root = tmp()
    mkdirSync(path.join(root, 'apps/sync-server/.wrangler/state'), { recursive: true })
    assert.deepEqual(findSharedDirs(root), ['apps/sync-server/.wrangler/state'])
  })

  it('returns nothing when the source has never run the dev server', () => {
    assert.deepEqual(findSharedDirs(tmp()), [])
  })

  it('carries the sync server database, which is the point', () => {
    assert.ok(SHARED_DIRS.includes('apps/sync-server/.wrangler/state'))
  })

  it('carries the repo skill set, so a worktree agent session is not skill-less', () => {
    assert.ok(SHARED_DIRS.includes('.claude/skills'))
  })

  it('shares only skills, never the whole gitignored .claude directory', () => {
    assert.ok(!SHARED_DIRS.includes('.claude'))
  })

  it('shares the Pi skills of a repo that tracks its Pi config, so a worktree session loads them', () => {
    // The repo's .gitignore since 1f852fd0b: `.pi` holds tracked config, so git does not ignore
    // `.pi` itself, only what is under it.
    const root = tmp()
    execFileSync('git', ['init', '-q', root])
    writeFileSync(path.join(root, '.gitignore'), '!.pi/\n.pi/*\n!.pi/settings.json\n')
    mkdirSync(path.join(root, '.pi/skills/tutorial-video'), { recursive: true })
    mkdirSync(path.join(root, '.pi/prompts'))
    mkdirSync(path.join(root, '.pi/goals'))
    writeFileSync(path.join(root, '.pi/settings.json'), '{}')
    execFileSync('git', ['add', '.gitignore', '.pi/settings.json'], { cwd: root })

    assert.deepEqual(filterIgnored(root, findSharedDirs(root)), ['.pi/skills', '.pi/prompts'])
  })
})

describe('findSharedFiles', () => {
  it('returns only the agent config files that exist in the source', () => {
    const root = tmp()
    writeFileSync(path.join(root, '.mcp.json'), '{}')
    assert.deepEqual(findSharedFiles(root), ['.mcp.json'])
  })

  it('returns nothing when the source declares no project MCP servers', () => {
    assert.deepEqual(findSharedFiles(tmp()), [])
  })

  it('carries the project MCP server list, which is the point', () => {
    assert.ok(SHARED_FILES.includes('.mcp.json'))
  })
})

describe('planAction on a shared state directory', () => {
  it('links a worktree that has no state of its own', () => {
    const dest = path.join(tmp(), 'state')
    assert.equal(planAction(dest, '/main/state', { mode: 'link', force: false }), 'link')
  })

  it('leaves a worktree that populated its own state alone', () => {
    const dest = path.join(tmp(), 'state')
    mkdirSync(dest)
    assert.equal(planAction(dest, '/main/state', { mode: 'link', force: false }), 'blocked')
    assert.equal(planAction(dest, '/main/state', { mode: 'link', force: true }), 'link')
  })

  it('reports an existing link to the same state as current', () => {
    const root = tmp()
    const main = path.join(root, 'main-state')
    const dest = path.join(root, 'state')
    mkdirSync(main)
    symlinkSync(main, dest, 'dir')
    assert.equal(planAction(dest, main, { mode: 'link', force: false }), 'current')
  })
})
