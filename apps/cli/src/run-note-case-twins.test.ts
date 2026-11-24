import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import test from 'node:test'

import { getNoteMetadataById, upsertNoteMetadata } from '@memry/storage-data'

import { openDatabases } from './app-core/database.ts'
import { runCli } from './run.ts'

const testRoot = path.join(process.cwd(), 'test-results', 'memry-cli-note-case-twins')
await fs.mkdir(testRoot, { recursive: true })

async function fileSystemIgnoresCase(): Promise<boolean> {
  const probe = path.join(testRoot, `CaseProbe-${randomUUID()}`)
  await fs.writeFile(probe, '')
  try {
    return await fs.access(path.join(testRoot, path.basename(probe).toLowerCase())).then(
      () => true,
      () => false
    )
  } finally {
    await fs.rm(probe)
  }
}

const skip = !(await fileSystemIgnoresCase()) && 'case-sensitive file system'

async function cli(vaultPath: string, ...args: string[]) {
  const stdout: string[] = []
  const stderr: string[] = []
  const code = await runCli(['--vault', vaultPath, '--json', ...args], {
    stdout: (line) => stdout.push(line),
    stderr: (line) => stderr.push(line)
  })
  return { code, stdout: stdout.join('\n'), stderr: stderr.join('\n') }
}

/**
 * `SuperNotes/Real.md` with two rows on it: the note the CLI created and a
 * twin spelled `Supernotes/Real.md`, the shape sync delivers from a
 * case-sensitive peer (#5263).
 */
async function makeTwinVault() {
  const vaultPath = path.join(testRoot, `vault-${process.pid}-${randomUUID()}`)
  await fs.mkdir(vaultPath)
  const created = await cli(
    vaultPath,
    'notes',
    'create',
    'Real',
    '--folder',
    'SuperNotes',
    '--content',
    'keep'
  )
  assert.equal(created.code, 0, created.stderr)
  const real = JSON.parse(created.stdout) as { id: string; path: string }
  assert.equal(real.path, 'SuperNotes/Real.md')
  const twin = { id: `note_twin_${randomUUID()}`, path: 'Supernotes/Real.md' }
  const databases = openDatabases(vaultPath)
  try {
    const row = getNoteMetadataById(databases.dataDb, real.id)
    assert.ok(row)
    upsertNoteMetadata(databases.dataDb, { ...row, ...twin })
  } finally {
    databases.close()
  }
  return { vaultPath, real, twin }
}

function rowPaths(vaultPath: string, ids: string[]): Array<string | null> {
  const databases = openDatabases(vaultPath)
  try {
    return ids.map((id) => getNoteMetadataById(databases.dataDb, id)?.path ?? null)
  } finally {
    databases.close()
  }
}

async function vaultFiles(vaultPath: string): Promise<string[]> {
  const entries = await fs.readdir(vaultPath, { recursive: true })
  return entries
    .map((entry) => entry.replaceAll('\\', '/'))
    .filter((entry) => !entry.startsWith('.memry') && entry.endsWith('.md'))
    .toSorted()
}

test('notes delete of a case twin keeps the file the other twin still uses', { skip }, async () => {
  const { vaultPath, real, twin } = await makeTwinVault()

  const deleted = await cli(vaultPath, 'notes', 'delete', twin.id, '--yes')
  assert.equal(deleted.code, 0, deleted.stderr)
  assert.deepEqual(JSON.parse(deleted.stdout), { success: true })
  assert.deepEqual(rowPaths(vaultPath, [real.id, twin.id]), ['SuperNotes/Real.md', null])
  const kept = await cli(vaultPath, 'notes', 'get', real.id)
  assert.equal(kept.code, 0, kept.stderr)
  assert.equal((JSON.parse(kept.stdout) as { content: string }).content.trim(), 'keep')

  // With no twin left, the file is the note's own and goes with it.
  const last = await cli(vaultPath, 'notes', 'delete', real.id, '--yes')
  assert.equal(last.code, 0, last.stderr)
  assert.deepEqual(await vaultFiles(vaultPath), [])
})

test(
  'notes delete of the exactly spelled twin keeps the file for the other',
  { skip },
  async () => {
    const { vaultPath, real, twin } = await makeTwinVault()

    const deleted = await cli(vaultPath, 'notes', 'delete', real.id, '--yes')
    assert.equal(deleted.code, 0, deleted.stderr)
    assert.deepEqual(rowPaths(vaultPath, [real.id, twin.id]), [null, 'Supernotes/Real.md'])
    assert.deepEqual(await vaultFiles(vaultPath), ['SuperNotes/Real.md'])
  }
)

test('notes rename and move refuse a case twin and change nothing', { skip }, async () => {
  const { vaultPath, real, twin } = await makeTwinVault()
  const attempts = [
    { args: ['notes', 'rename', twin.id, 'Other'], verb: 'rename' },
    { args: ['notes', 'update', real.id, '--title', 'Other'], verb: 'rename' },
    { args: ['notes', 'move', twin.id, 'Elsewhere'], verb: 'move' },
    { args: ['notes', 'move', real.id, ''], verb: 'move' }
  ]
  for (const { args, verb } of attempts) {
    const result = await cli(vaultPath, ...args)
    assert.equal(result.code, 1, args.join(' '))
    assert.equal(result.stdout, '', args.join(' '))
    assert.match(
      result.stderr,
      new RegExp(`Refusing to ${verb} note ".+": note ".+" shares its file`)
    )
    assert.deepEqual(rowPaths(vaultPath, [real.id, twin.id]), [
      'SuperNotes/Real.md',
      'Supernotes/Real.md'
    ])
    assert.deepEqual(await vaultFiles(vaultPath), ['SuperNotes/Real.md'], args.join(' '))
  }
})

test('folders rename refuses a folder holding case twins and moves nothing', { skip }, async () => {
  const { vaultPath, twin } = await makeTwinVault()
  for (const folder of ['SuperNotes', 'supernotes']) {
    const result = await cli(vaultPath, 'folders', 'rename', folder, 'Archive')
    assert.equal(result.code, 1, folder)
    assert.equal(result.stdout, '', folder)
    assert.match(result.stderr, /Refusing to rename folder ".+": note ".+" shares its file/)
    assert.deepEqual(await vaultFiles(vaultPath), ['SuperNotes/Real.md'], folder)
  }

  // Once the twin is gone the folder is free to move.
  assert.equal((await cli(vaultPath, 'notes', 'delete', twin.id, '--yes')).code, 0)
  const renamed = await cli(vaultPath, 'folders', 'rename', 'SuperNotes', 'Archive')
  assert.equal(renamed.code, 0, renamed.stderr)
  assert.deepEqual(await vaultFiles(vaultPath), ['Archive/Real.md'])
})

test(
  'rows whose paths fold alike but name two files are not twins',
  { skip: !skip && 'case-insensitive file system' },
  async () => {
    const attempts = [
      {
        args: (twinId: string) => ['notes', 'delete', twinId, '--yes'],
        files: ['SuperNotes/Real.md']
      },
      {
        args: (twinId: string) => ['notes', 'rename', twinId, 'Other'],
        files: ['SuperNotes/Real.md', 'Supernotes/Other.md']
      },
      {
        args: (twinId: string) => ['notes', 'move', twinId, 'Elsewhere'],
        files: ['Elsewhere/Real.md', 'SuperNotes/Real.md']
      },
      {
        args: () => ['folders', 'rename', 'SuperNotes', 'Archive'],
        files: ['Archive/Real.md', 'Supernotes/Real.md']
      }
    ]
    for (const { args, files } of attempts) {
      const { vaultPath, twin } = await makeTwinVault()
      await fs.mkdir(path.join(vaultPath, 'Supernotes'))
      await fs.writeFile(path.join(vaultPath, twin.path), 'other\n')

      const result = await cli(vaultPath, ...args(twin.id))
      assert.equal(result.code, 0, result.stderr)
      assert.deepEqual(await vaultFiles(vaultPath), files, args(twin.id).join(' '))
    }
  }
)
