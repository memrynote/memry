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

/** Runs the command in a fresh world, so each form starts from the same files. */
async function assertRefused(
  command: string[] | ((world: World) => string[]),
  reason: RegExp,
  setup?: (world: World) => Promise<void>
) {
  const world = await makeWorld()
  await setup?.(world)
  const args = typeof command === 'function' ? command(world) : command
  const before = await snapshot(world.world)
  const result = await cli(world.vaultPath, ...args)
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
  for (const folder of ['..', '../outside', '.']) {
    await assertRefused(({ note }) => ['notes', 'move', note.id, folder], OUTSIDE)
  }
})

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
    await assertRefused(
      ['notes', 'delete-attachment', 'note_link', 'keep.md', '--yes'],
      LINK,
      async ({ vaultPath }) => {
        await fs.mkdir(path.join(vaultPath, 'attachments'), { recursive: true })
        await fs.symlink(
          path.join('..', '..', 'outside', 'data'),
          path.join(vaultPath, 'attachments', 'note_link')
        )
      }
    )
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

/** Every command that reads or writes a folder's `.folder.md`, for one folder argument. */
function folderConfigCommands(folder: string): string[][] {
  return [
    ['folders', 'template', folder],
    ['folder-view', 'config', folder],
    ['folder-view', 'views', folder],
    ['folder-view', 'properties', folder],
    ['folders', 'template', folder, '--clear'],
    ['folder-view', 'set-config', folder, '{"icon":"x"}'],
    ['folder-view', 'set-view', folder, '{"name":"Table","type":"table"}'],
    ['folder-view', 'delete-view', folder, 'Table']
  ]
}

test('folders template and folder-view refuse a folder outside the vault', async () => {
  for (const folder of ['..', '../escaped', '../outside/data', 'SuperNotes/../..']) {
    for (const command of folderConfigCommands(folder)) await assertRefused(command, OUTSIDE)
  }
})

test(
  'folders template and folder-view refuse a folder through a link',
  { skip: skipLinks },
  async () => {
    for (const folder of ['out', 'out/new', 'zz/outside/data']) {
      for (const command of folderConfigCommands(folder)) await assertRefused(command, LINK)
    }
  }
)

test('folders template and folder-view still write the vault root for . and /', async () => {
  const { vaultPath } = await makeWorld()
  for (const folder of ['.', '/']) {
    for (const command of folderConfigCommands(folder)) {
      const result = await cli(vaultPath, ...command)
      assert.equal(result.code, 0, `${command.join(' ')}: ${result.stderr}`)
    }
  }
  assert.match(await fs.readFile(path.join(vaultPath, '.folder.md'), 'utf-8'), /icon: x/)
})

/** Captures an image into the world's inbox and returns its item id. */
async function captureImage({ world, vaultPath }: World): Promise<string> {
  const source = path.join(world, 'shot.png')
  await fs.writeFile(source, 'png-bytes')
  const captured = await cli(vaultPath, 'inbox', 'capture-image', source, '--title', 'Shot')
  assert.equal(captured.code, 0, captured.stderr)
  return (JSON.parse(captured.stdout.at(-1) ?? '{}') as { id: string }).id
}

test('inbox file refuses a folder outside the vault for an image', async () => {
  for (const folder of ['..', '../outside/data', 'SuperNotes/../..']) {
    let itemId = ''
    await assertRefused(
      () => ['inbox', 'file', itemId, '--folder', folder],
      OUTSIDE,
      async (world) => {
        itemId = await captureImage(world)
      }
    )
  }
})

test('inbox file refuses a folder through a link', { skip: skipLinks }, async () => {
  for (const folder of ['out', 'out/x', 'zz/outside/data']) {
    let itemId = ''
    await assertRefused(
      () => ['inbox', 'file', itemId, '--folder', folder],
      LINK,
      async (world) => {
        itemId = await captureImage(world)
      }
    )
  }
})

test('inbox file takes . as the vault root for an image and a text item', async () => {
  const world = await makeWorld()
  const imageId = await captureImage(world)
  const image = await cli(world.vaultPath, 'inbox', 'file', imageId, '--folder', '.')
  assert.equal(image.code, 0, image.stderr)
  assert.equal(
    (JSON.parse(image.stdout.at(-1) ?? '{}') as { filedTo?: string }).filedTo,
    'Shot.png'
  )

  const captured = await cli(world.vaultPath, 'inbox', 'capture', 'Loose thought')
  const textId = (JSON.parse(captured.stdout.at(-1) ?? '{}') as { id: string }).id
  const text = await cli(world.vaultPath, 'inbox', 'file', textId, '--folder', '.')
  assert.equal(text.code, 0, text.stderr)
  assert.equal(
    (JSON.parse(text.stdout.at(-1) ?? '{}') as { filedTo?: string }).filedTo,
    'Loose thought.md'
  )
})

/** The `notes import-files` and `projects import-files` forms of one import into `folder`. */
function importCommands(folder: string) {
  let projectId = ''
  const source = ({ world }: World) => path.join(world, 'outside', 'data', 'keep.md')
  return [
    {
      command: (world: World) => ['notes', 'import-files', source(world), '--folder', folder],
      setup: undefined
    },
    {
      command: (world: World) => [
        'projects',
        'import-files',
        projectId,
        source(world),
        '--folder',
        folder
      ],
      setup: async ({ vaultPath }: World) => {
        const created = await cli(vaultPath, 'projects', 'create', 'Imports')
        assert.equal(created.code, 0, created.stderr)
        projectId = (JSON.parse(created.stdout.at(-1) ?? '{}') as { id: string }).id
      }
    }
  ]
}

test('notes and projects import-files refuse a folder outside the vault', async () => {
  for (const folder of ['..', '../outside', 'SuperNotes/../..']) {
    for (const { command, setup } of importCommands(folder)) {
      await assertRefused(command, OUTSIDE, setup)
    }
  }
})

test(
  'notes and projects import-files refuse a folder through a link',
  { skip: skipLinks },
  async () => {
    for (const folder of ['out', 'out/new', 'zz/outside']) {
      for (const { command, setup } of importCommands(folder)) {
        await assertRefused(command, LINK, setup)
      }
    }
  }
)

test('canvas create refuses a canvas folder through a link', { skip: skipLinks }, async () => {
  for (const folder of ['cv', 'cv/deeper']) {
    await assertRefused(
      ['canvas', 'create', '--title', 'C', '--folder', folder],
      LINK,
      async ({ vaultPath }) => {
        await fs.mkdir(path.join(vaultPath, 'canvases'))
        await fs.symlink(path.join('..', '..', 'outside'), path.join(vaultPath, 'canvases', 'cv'))
      }
    )
  }
  await assertRefused(['canvas', 'create', '--title', 'C'], LINK, async ({ vaultPath }) => {
    await fs.symlink(path.join('..', 'outside'), path.join(vaultPath, 'canvases'))
  })
})

test('notes attach refuses an attachments folder that is a link', { skip: skipLinks }, async () => {
  const attach = ({ world, note }: World) => [
    'notes',
    'attach',
    note.id,
    path.join(world, 'shot.png')
  ]
  await assertRefused(attach, LINK, async ({ world, vaultPath, note }) => {
    await fs.writeFile(path.join(world, 'shot.png'), 'png-bytes')
    await fs.symlink(
      path.join('..', '..', 'outside', 'data'),
      path.join(vaultPath, 'attachments', note.id)
    )
  })
  await assertRefused(attach, LINK, async ({ world, vaultPath }) => {
    await fs.writeFile(path.join(world, 'shot.png'), 'png-bytes')
    await fs.rm(path.join(vaultPath, 'attachments'), { recursive: true })
    await fs.symlink('../outside', path.join(vaultPath, 'attachments'))
    // Opening the vault makes `attachments/images` and `attachments/files`, through the link too.
    await fs.mkdir(path.join(world, 'outside', 'images'))
    await fs.mkdir(path.join(world, 'outside', 'files'))
  })
})
