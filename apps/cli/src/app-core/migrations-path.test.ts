import assert from 'node:assert/strict'
import test from 'node:test'

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { openDatabases } from './database.ts'
import {
  isMigrationsDir,
  migrationsDirCandidates,
  migrationsDirEnvVar,
  resolveMigrationsDir,
  type MigrationsKind
} from './migrations-path.ts'

// Real directory trees, not a stubbed `exists` predicate: the bug in #1722 was
// that a path was accepted without anyone checking whether it existed, so a
// test that mocks existence away cannot catch a regression of it.
function makeTempRoot(label: string): string {
  return fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), `memry-${label}-`))
}

/** A folder drizzle would accept: it has meta/_journal.json. */
function seedMigrationsFolder(dir: string, kind: MigrationsKind): string {
  const folder = path.join(dir, `drizzle-${kind}`)
  fs.mkdirSync(path.join(folder, 'meta'), { recursive: true })
  fs.writeFileSync(
    path.join(folder, 'meta', '_journal.json'),
    JSON.stringify({ version: '7', dialect: 'sqlite', entries: [] })
  )
  return folder
}

/** Lays out `<root>/apps/desktop/src/main/database/drizzle-<kind>` like a checkout. */
function seedSourceCheckout(root: string, kind: MigrationsKind): string {
  const parent = path.join(root, 'apps', 'desktop', 'src', 'main', 'database')
  fs.mkdirSync(parent, { recursive: true })
  return seedMigrationsFolder(parent, kind)
}

test('isMigrationsDir accepts a folder only when drizzle journal is present', () => {
  const root = makeTempRoot('journal')
  try {
    const empty = path.join(root, 'drizzle-data')
    fs.mkdirSync(empty, { recursive: true })
    assert.equal(isMigrationsDir(empty), false, 'an empty folder is not a migrations folder')

    const seeded = seedMigrationsFolder(root, 'index')
    assert.equal(isMigrationsDir(seeded), true)
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

// Issue #1722: in the packaged Linux build app-core is bundled into
// app.asar/out/main/index.js and copyMigrations() drops drizzle-data/ and
// drizzle-index/ right beside it. No ancestor is named "memry" and no source
// checkout exists on the box, so the old name-matching walk fell through to
// process.cwd() and handed drizzle a path that was never there.
test('resolves the folder bundled next to the module (packaged app.asar layout)', () => {
  const root = makeTempRoot('packaged')
  try {
    const outMain = path.join(root, 'app.asar', 'out', 'main')
    fs.mkdirSync(outMain, { recursive: true })
    const dataFolder = seedMigrationsFolder(outMain, 'data')
    const indexFolder = seedMigrationsFolder(outMain, 'index')

    // cwd is wherever the user happened to run the CLI from, and has nothing.
    const lookup = { moduleDir: outMain, cwd: makeTempRoot('packaged-cwd') }

    assert.equal(resolveMigrationsDir('data', lookup), dataFolder)
    assert.equal(resolveMigrationsDir('index', lookup), indexFolder)
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('resolves a bundle emitted one level down (out/main/chunks/)', () => {
  const root = makeTempRoot('chunked')
  try {
    const outMain = path.join(root, 'out', 'main')
    const chunks = path.join(outMain, 'chunks')
    fs.mkdirSync(chunks, { recursive: true })
    const dataFolder = seedMigrationsFolder(outMain, 'data')

    assert.equal(resolveMigrationsDir('data', { moduleDir: chunks, cwd: root }), dataFolder)
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('resolves the checkout folders when running from source', () => {
  const root = makeTempRoot('checkout')
  try {
    const dataFolder = seedSourceCheckout(root, 'data')
    const moduleDir = path.join(root, 'packages', 'app-core', 'src')
    fs.mkdirSync(moduleDir, { recursive: true })

    assert.equal(resolveMigrationsDir('data', { moduleDir, cwd: root }), dataFolder)
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

// The old walk matched on a directory *name* (endsWith("/memry")), so from a
// worktree nested under the main checkout it climbed straight past the worktree
// and ran the outer branch's migrations — silently, with tests still green.
test('a nested worktree resolves its own migrations, not the outer checkout', () => {
  const root = makeTempRoot('worktree')
  try {
    const outer = path.join(root, 'memry')
    const worktree = path.join(outer, '.claude', 'worktrees', 'some-branch')
    fs.mkdirSync(worktree, { recursive: true })

    const outerFolder = seedSourceCheckout(outer, 'data')
    const worktreeFolder = seedSourceCheckout(worktree, 'data')

    const moduleDir = path.join(worktree, 'packages', 'app-core', 'src')
    fs.mkdirSync(moduleDir, { recursive: true })

    const resolved = resolveMigrationsDir('data', { moduleDir, cwd: worktree })
    assert.equal(resolved, worktreeFolder)
    assert.notEqual(resolved, outerFolder)
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

// The old walk only ever matched a directory literally named "memry", so any
// clone under another name fell through to process.cwd().
test('a checkout cloned under any folder name still resolves', () => {
  const root = makeTempRoot('renamed')
  try {
    const checkout = path.join(root, 'not-called-memry')
    const dataFolder = seedSourceCheckout(checkout, 'data')
    const moduleDir = path.join(checkout, 'packages', 'app-core', 'src')
    fs.mkdirSync(moduleDir, { recursive: true })

    assert.equal(
      resolveMigrationsDir('data', { moduleDir, cwd: makeTempRoot('renamed-cwd') }),
      dataFolder
    )
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('the env override wins over both the bundle and the checkout', () => {
  const root = makeTempRoot('override')
  try {
    const outMain = path.join(root, 'out', 'main')
    fs.mkdirSync(outMain, { recursive: true })
    const bundled = seedMigrationsFolder(outMain, 'data')

    const overrideBase = path.join(root, 'override')
    fs.mkdirSync(overrideBase, { recursive: true })
    const overridden = seedMigrationsFolder(overrideBase, 'data')

    const resolved = resolveMigrationsDir('data', {
      moduleDir: outMain,
      cwd: root,
      envDir: overrideBase
    })
    assert.equal(resolved, overridden)
    assert.notEqual(resolved, bundled)
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('an override pointing at a folder without a journal is skipped, not trusted', () => {
  const root = makeTempRoot('bad-override')
  try {
    const outMain = path.join(root, 'out', 'main')
    fs.mkdirSync(outMain, { recursive: true })
    const bundled = seedMigrationsFolder(outMain, 'data')

    const overrideBase = path.join(root, 'empty-override')
    fs.mkdirSync(path.join(overrideBase, 'drizzle-data'), { recursive: true })

    assert.equal(
      resolveMigrationsDir('data', { moduleDir: outMain, cwd: root, envDir: overrideBase }),
      bundled
    )
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('failure names the paths that were tried instead of drizzle’s bare journal error', () => {
  const root = makeTempRoot('missing')
  try {
    const moduleDir = path.join(root, 'out', 'main')
    fs.mkdirSync(moduleDir, { recursive: true })

    assert.throws(
      () => resolveMigrationsDir('data', { moduleDir, cwd: root }),
      (error: Error) => {
        assert.match(error.message, /Could not find the drizzle-data migrations folder/)
        assert.match(error.message, new RegExp(migrationsDirEnvVar))
        assert.ok(
          error.message.includes(path.join(moduleDir, 'drizzle-data')),
          'the message lists the concrete candidates that were checked'
        )
        assert.doesNotMatch(error.message, /^Can't find meta\/_journal\.json file$/)
        return true
      }
    )
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('candidates are ordered, de-duplicated, and never mix the two kinds', () => {
  const lookup = { moduleDir: '/pkg/out/main', cwd: '/pkg/out/main', envDir: '/opt/migrations' }
  const candidates = migrationsDirCandidates('index', lookup)

  assert.equal(candidates[0], path.join('/opt/migrations', 'drizzle-index'))
  assert.equal(candidates[1], path.join('/pkg/out/main', 'drizzle-index'))
  assert.equal(new Set(candidates).size, candidates.length, 'no duplicate candidates')
  assert.ok(
    candidates.every((dir) => dir.endsWith('drizzle-index')),
    'a data lookup never leaks into an index lookup'
  )
})

// End-to-end guard for the reported symptom: opening a vault must not depend on
// the directory the process was launched from.
test('openDatabases migrates a fresh vault regardless of process.cwd()', () => {
  const vaultPath = makeTempRoot('vault')
  const elsewhere = makeTempRoot('elsewhere')
  const originalCwd = process.cwd()
  try {
    process.chdir(elsewhere)
    const databases = openDatabases(vaultPath)
    try {
      const tables = databases.dataSqlite
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
        .all() as { name: string }[]
      assert.ok(
        tables.some((row) => row.name === 'projects'),
        'data.db is migrated'
      )
      const inbox = databases.dataSqlite
        .prepare('SELECT id FROM projects WHERE id = ?')
        .get('inbox')
      assert.ok(inbox, 'the default task project is seeded')
    } finally {
      databases.close()
    }
  } finally {
    process.chdir(originalCwd)
    fs.rmSync(vaultPath, { recursive: true, force: true })
    fs.rmSync(elsewhere, { recursive: true, force: true })
  }
})
