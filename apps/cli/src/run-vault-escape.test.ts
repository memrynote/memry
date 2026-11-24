import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import test from 'node:test'

import { runCli } from './run.ts'

const testRoot = path.join(process.cwd(), 'test-results', 'memry-cli-vault-escape')
await fs.mkdir(testRoot, { recursive: true })

// Creating a symlink on Windows needs a privilege CI runners lack.
const skipLinks = process.platform === 'win32' && 'symlinks need privileges on Windows'

async function cli(vaultPath: string, ...args: string[]) {
  const stdout: string[] = []
  const stderr: string[] = []
  const code = await runCli(['--vault', vaultPath, '--json', ...args], {
    stdout: (line) => stdout.push(line),
    stderr: (line) => stderr.push(line)
  })
  return { code, stdout, stderr: stderr.join('\n') }
}

/**
 * `world/vault` with the note `SuperNotes/Real.md`, beside `world/outside/data/keep.md`,
 * and the links `vault/out -> ../outside` and `vault/zz -> ..`.
 */
async function makeWorld() {
  const world = path.join(testRoot, `world-${process.pid}-${randomUUID()}`)
  const vaultPath = path.join(world, 'vault')
  await fs.mkdir(path.join(world, 'outside', 'data'), { recursive: true })
  await fs.writeFile(path.join(world, 'outside', 'data', 'keep.md'), '# Keep\n')
  await fs.mkdir(vaultPath)
  const created = await cli(vaultPath, 'notes', 'create', 'Real', '--folder', 'SuperNotes')
  assert.equal(created.code, 0, created.stderr)
  const note = JSON.parse(created.stdout.at(-1) ?? '{}') as { id: string; path: string }
  if (!skipLinks) {
    await fs.symlink(path.join('..', 'outside'), path.join(vaultPath, 'out'))
    await fs.symlink('..', path.join(vaultPath, 'zz'))
  }
  return { world, vaultPath, note }
}

/** Every entry under `world` except the vault's databases, which any command opens. */
async function snapshot(world: string): Promise<string[]> {
  const entries = await fs.readdir(world, { recursive: true })
  return entries
    .map((entry) => entry.replaceAll('\\', '/'))
    .filter((entry) => !entry.startsWith('vault/.memry/'))
    .toSorted()
}

type World = Awaited<ReturnType<typeof makeWorld>>

/**
 * Runs the command in a fresh world, so each form starts from the same files. `platform`
 * stands in for `process.platform` while the command runs, as desktop's `paths.test.ts` does.
 */
async function assertRefused(
  command: string[] | ((world: World) => string[]),
  reason: RegExp,
  { setup, platform }: { setup?: (world: World) => Promise<void>; platform?: NodeJS.Platform } = {}
) {
  const world = await makeWorld()
  await setup?.(world)
  const args = typeof command === 'function' ? command(world) : command
  const before = await snapshot(world.world)
  const actual = process.platform
  if (platform) Object.defineProperty(process, 'platform', { value: platform })
  const result = await cli(world.vaultPath, ...args).finally(() => {
    Object.defineProperty(process, 'platform', { value: actual })
  })
  const label = args.join(' ')

  assert.equal(result.code, 1, `${label} exit code; stderr: ${result.stderr}`)
  assert.deepEqual(result.stdout, [], label)
  assert.match(result.stderr, reason, label)
  assert.doesNotMatch(result.stderr, /the disk spells it differently/, label)
  assert.deepEqual(await snapshot(world.world), before, `${label} changed files`)
}

const OUTSIDE = /^Refusing to .+: ".+" is the vault itself or outside it\.$/
const LINK =
  /^Refusing to .+: ".+" is a link, and a path through a link can lead outside the vault\.$/
const WINDOWS_ALIAS =
  /^Refusing to .+: ".+" ends in a dot or a space, which Windows drops, so it names another folder\.$/

test('folders delete refuses the vault root and paths that leave it, with its own message', async () => {
  for (const folder of ['/', '.', 'SuperNotes/..', '..', '../outside/data', '../outside/gone']) {
    await assertRefused(['folders', 'delete', folder, '--yes'], OUTSIDE)
  }
})

test('folders delete refuses a path through a link', { skip: skipLinks }, async () => {
  for (const folder of ['out/data', 'out', 'zz/vault/SuperNotes', 'zz/outside/data']) {
    await assertRefused(['folders', 'delete', folder, '--yes'], LINK)
  }
})

test('folders rename refuses an old or new path that leaves the vault', async () => {
  for (const [from, to] of [
    ['SuperNotes', '../other/escaped'],
    ['SuperNotes', '..'],
    ['SuperNotes', '/'],
    ['../outside/data', 'Stolen'],
    ['.', 'Archive']
  ]) {
    await assertRefused(['folders', 'rename', from, to], OUTSIDE)
  }
})

test('folders rename refuses an old or new path through a link', { skip: skipLinks }, async () => {
  for (const [from, to] of [
    ['SuperNotes', 'out/escaped'],
    ['out/data', 'Stolen'],
    ['zz/outside/data', 'Stolen']
  ]) {
    await assertRefused(['folders', 'rename', from, to], LINK)
  }
})

test('folders create and notes create refuse a folder outside the vault', async () => {
  await assertRefused(['folders', 'create', '../escaped'], OUTSIDE)
  await assertRefused(['notes', 'create', 'Escaped', '--folder', '../escaped'], OUTSIDE)
})

test(
  'folders create and notes create refuse a folder through a link',
  { skip: skipLinks },
  async () => {
    await assertRefused(['folders', 'create', 'out/new'], LINK)
    await assertRefused(['notes', 'create', 'Escaped', '--folder', 'out/data'], LINK)
  }
)

test('notes move refuses a folder outside the vault', async () => {
  for (const folder of ['..', '../outside', 'SuperNotes/../..']) {
    await assertRefused(({ note }) => ['notes', 'move', note.id, folder], OUTSIDE)
  }
})

test('. names the vault root for notes move and notes create', async () => {
  const { vaultPath, note } = await makeWorld()

  const moved = await cli(vaultPath, 'notes', 'move', note.id, '.')
  assert.equal(moved.code, 0, moved.stderr)
  assert.equal((JSON.parse(moved.stdout.at(-1) ?? '{}') as { path?: string }).path, 'Real.md')

  const created = await cli(vaultPath, 'notes', 'create', 'Top', '--folder', './')
  assert.equal(created.code, 0, created.stderr)
  assert.equal((JSON.parse(created.stdout.at(-1) ?? '{}') as { path?: string }).path, 'Top.md')

  await fs.access(path.join(vaultPath, 'Real.md'))
  await fs.access(path.join(vaultPath, 'Top.md'))
})

// Win32 drops a trailing dot or space, so `SuperNotes.` there is `SuperNotes`, a spelling the
// rows and the case-twin check do not see (#5647).
test('on Windows, a folder name ending in a dot or a space is refused', async () => {
  const onWindows = { platform: 'win32' } as const
  for (const [from, to] of [
    ['SuperNotes.', 'Archive'],
    ['SuperNotes ', 'Archive'],
    ['SuperNotes', 'Archive.']
  ]) {
    await assertRefused(['folders', 'rename', from, to], WINDOWS_ALIAS, onWindows)
  }
  for (const folder of ['Archive.', 'Archive /Sub']) {
    await assertRefused(({ note }) => ['notes', 'move', note.id, folder], WINDOWS_ALIAS, onWindows)
  }
})

test(
  'import start lists the refusal for each note it cannot write',
  { skip: skipLinks },
  async () => {
    const { world, vaultPath } = await makeWorld()
    const source = path.join(world, 'import')
    await fs.mkdir(source)
    await fs.writeFile(path.join(source, 'One.md'), '# One\n')
    await fs.writeFile(path.join(source, 'Two.md'), '# Two\n')
    const before = await snapshot(world)

    const result = await cli(
      vaultPath,
      'import',
      'start',
      'markdown',
      source,
      '--folder',
      'out/imp'
    )

    // A run that imports nothing still exits 0 (shipped contract); the summary carries each reason.
    assert.equal(result.code, 0, result.stderr)
    const summary = JSON.parse(result.stdout.at(-1) ?? '{}') as {
      imported: number
      failed: Array<{ item: string; error: string }>
    }
    assert.equal(summary.imported, 0)
    assert.equal(summary.failed.length, 2)
    for (const entry of summary.failed) assert.match(entry.error, LINK, entry.item)
    assert.deepEqual(await snapshot(world), before)
  }
)

test('notes move refuses a folder through a link', { skip: skipLinks }, async () => {
  for (const folder of ['out/data', 'zz/outside']) {
    await assertRefused(({ note }) => ['notes', 'move', note.id, folder], LINK)
  }
})

test('notes delete-attachment refuses an id or file name that is not plain', async () => {
  for (const [noteId, filename, reason] of [
    ['../SuperNotes', 'Real.md', /is not a note id/],
    ['..', 'SuperNotes', /is not a note id/],
    ['.', 'x.png', /is not a note id/],
    ['a/../../SuperNotes', 'Real.md', /is not a note id/],
    ['note_x', '..', /is not an attachment file name/],
    ['note_x', '.', /is not an attachment file name/]
  ] as const) {
    await assertRefused(['notes', 'delete-attachment', noteId, filename, '--yes'], reason)
  }
})

test(
  'notes delete-attachment refuses a note folder that is a link',
  { skip: skipLinks },
  async () => {
    await assertRefused(['notes', 'delete-attachment', 'note_link', 'keep.md', '--yes'], LINK, {
      setup: async ({ vaultPath }) => {
        await fs.mkdir(path.join(vaultPath, 'attachments'), { recursive: true })
        await fs.symlink(
          path.join('..', '..', 'outside', 'data'),
          path.join(vaultPath, 'attachments', 'note_link')
        )
      }
    })
  }
)

test(
  'a vault opened through a link still renames, moves and deletes',
  { skip: skipLinks },
  async () => {
    const { world, note } = await makeWorld()
    const linkedVault = path.join(world, 'vault-link')
    await fs.symlink('vault', linkedVault)

    const moved = await cli(linkedVault, 'notes', 'move', note.id, 'Inbox')
    assert.equal(moved.code, 0, moved.stderr)
    assert.equal(
      (JSON.parse(moved.stdout.at(-1) ?? '{}') as { path?: string }).path,
      'Inbox/Real.md'
    )

    const renamed = await cli(linkedVault, 'folders', 'rename', 'Inbox', 'Archive/Inbox')
    assert.equal(renamed.code, 0, renamed.stderr)
    assert.deepEqual(JSON.parse(renamed.stdout.at(-1) ?? '{}'), { path: 'Archive/Inbox' })

    const deleted = await cli(linkedVault, 'folders', 'delete', 'Archive', '--yes')
    assert.equal(deleted.code, 0, deleted.stderr)
    assert.deepEqual(JSON.parse(deleted.stdout.at(-1) ?? '{}'), { success: true })
    await assert.rejects(fs.access(path.join(world, 'vault', 'Archive')), { code: 'ENOENT' })
  }
)
