import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import test from 'node:test'

import { customIcons, homePages, syncPendingDeletes } from '@memry/db-schema/data-schema'
import { eq } from 'drizzle-orm'

import { runCli } from '../run.ts'
import { openDatabases } from './database.ts'

async function makeVault() {
  const root = path.join(process.cwd(), 'test-results', 'memry-cli-home-icons')
  await fs.mkdir(root, { recursive: true })
  const vaultPath = path.join(root, `vault-${process.pid}-${randomUUID()}`)
  await fs.mkdir(vaultPath)
  return vaultPath
}

async function run(vaultPath: string, args: string[]) {
  const stdout: string[] = []
  const stderr: string[] = []
  const code = await runCli(['--vault', vaultPath, '--json', ...args], {
    stdout: (line) => stdout.push(line),
    stderr: (line) => stderr.push(line)
  })
  return { code, stdout: stdout.join('\n'), stderr: stderr.join('\n') }
}

async function runOk<T>(vaultPath: string, args: string[]): Promise<T> {
  const result = await run(vaultPath, args)
  assert.equal(result.code, 0, result.stderr)
  return JSON.parse(result.stdout) as T
}

function withDatabases<T>(
  vaultPath: string,
  callback: (db: ReturnType<typeof openDatabases>) => T
) {
  const databases = openDatabases(vaultPath)
  try {
    return callback(databases)
  } finally {
    databases.close()
  }
}

function pngBytes(width: number, height: number): Buffer {
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  const chunk = (type: string, data: Buffer) => {
    const length = Buffer.alloc(4)
    length.writeUInt32BE(data.length)
    return Buffer.concat([length, Buffer.from(type), data, Buffer.alloc(4)])
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IEND', Buffer.alloc(0))
  ])
}

interface IconJson {
  id: string
  name: string
  ext: string
  path: string
}

test('home-pages list and get read boards in position order and upgrade legacy widget sizes', async () => {
  const vaultPath = await makeVault()
  await runOk(vaultPath, ['vault', 'init'])
  withDatabases(vaultPath, ({ dataDb }) => {
    dataDb
      .insert(homePages)
      .values([
        {
          id: 'b2',
          name: 'Second',
          position: 1,
          widgets: JSON.stringify([{ id: 'w', type: 'tasks', x: 1, y: 2, w: 3, h: 4, config: {} }])
        },
        {
          id: 'b1',
          name: 'First',
          icon: 'home',
          position: 0,
          // Pre-grid boards stored a size letter; desktop upgrades them on read.
          widgets: JSON.stringify([
            { id: 'a', type: 'notes', size: 'S' },
            { id: 'b', type: 'tasks', size: 'L', config: { k: 1 } }
          ])
        },
        { id: 'b3', name: 'Broken', position: 2, widgets: '{not json' }
      ])
      .run()
  })

  const pages = await runOk<Array<{ id: string; widgets: Array<Record<string, unknown>> }>>(
    vaultPath,
    ['home-pages', 'list']
  )
  assert.deepEqual(
    pages.map((page) => page.id),
    ['b1', 'b2', 'b3']
  )
  assert.deepEqual(pages[0].widgets, [
    { id: 'a', type: 'notes', x: 0, y: 0, w: 2, h: 2, config: {} },
    { id: 'b', type: 'tasks', x: 0, y: 2, w: 8, h: 4, config: { k: 1 } }
  ])
  assert.deepEqual(
    pages[2].widgets,
    [],
    'an unparseable board degrades to empty instead of failing the list'
  )

  const one = await runOk<{ name: string; icon: string }>(vaultPath, ['home-pages', 'get', 'b1'])
  assert.equal(one.name, 'First')
  assert.equal(one.icon, 'home')
  assert.equal((await run(vaultPath, ['home-pages', 'get', 'missing'])).code, 1)
})

test('icons add stores svg (sanitized) and png, writes the file, and lists them', async () => {
  const vaultPath = await makeVault()
  const svgPath = path.join(vaultPath, 'star.svg')
  await fs.writeFile(
    svgPath,
    '<svg xmlns="http://www.w3.org/2000/svg" onload="x()"><script>x()</script><path d="M0 0"/></svg>'
  )
  const pngPath = path.join(vaultPath, 'dot.png')
  await fs.writeFile(pngPath, pngBytes(64, 32))

  const svg = await runOk<IconJson>(vaultPath, ['icons', 'add', svgPath])
  assert.equal(svg.name, 'star')
  assert.equal(svg.ext, 'svg')
  const stored = await fs.readFile(svg.path, 'utf8')
  assert.doesNotMatch(stored, /script|onload/)
  assert.equal(svg.path, path.join(vaultPath, '.memry', 'icons', `${svg.id}.svg`))

  const png = await runOk<IconJson>(vaultPath, ['icons', 'add', pngPath, '--name', 'Dot'])
  assert.equal(png.name, 'Dot')
  assert.equal(png.ext, 'png')

  const listed = await runOk<IconJson[]>(vaultPath, ['icons', 'list'])
  assert.deepEqual(listed.map((icon) => icon.id).toSorted(), [png.id, svg.id].toSorted())

  // The row carries the whole payload, so a missing file is rebuilt on list.
  await fs.rm(png.path)
  await runOk(vaultPath, ['icons', 'list'])
  assert.deepEqual(await fs.readFile(png.path), pngBytes(64, 32))
})

test('icons add refuses what the CLI cannot normalize and says what to do', async () => {
  const vaultPath = await makeVault()
  const big = path.join(vaultPath, 'big.png')
  await fs.writeFile(big, pngBytes(512, 512))
  const jpg = path.join(vaultPath, 'photo.jpg')
  await fs.writeFile(jpg, Buffer.from([0xff, 0xd8, 0xff]))
  const fake = path.join(vaultPath, 'fake.png')
  await fs.writeFile(fake, Buffer.from('not a png'))
  const notSvg = path.join(vaultPath, 'x.svg')
  await fs.writeFile(notSvg, '<div>no</div>')

  assert.match((await run(vaultPath, ['icons', 'add', big])).stderr, /limited to 128px/)
  assert.match((await run(vaultPath, ['icons', 'add', jpg])).stderr, /svg and png/)
  assert.match((await run(vaultPath, ['icons', 'add', fake])).stderr, /not a valid PNG/)
  assert.match((await run(vaultPath, ['icons', 'add', notSvg])).stderr, /not a usable SVG/)
  assert.deepEqual(await runOk(vaultPath, ['icons', 'list']), [])
})

test('icons rename updates the label and delete needs --yes', async () => {
  const vaultPath = await makeVault()
  const pngPath = path.join(vaultPath, 'dot.png')
  await fs.writeFile(pngPath, pngBytes(8, 8))
  const icon = await runOk<IconJson>(vaultPath, ['icons', 'add', pngPath])

  const renamed = await runOk<IconJson>(vaultPath, ['icons', 'rename', icon.id, 'Renamed'])
  assert.equal(renamed.name, 'Renamed')
  assert.equal((await run(vaultPath, ['icons', 'rename', 'nope', 'x'])).code, 1)

  assert.match((await run(vaultPath, ['icons', 'delete', icon.id])).stderr, /--yes/)
  const deleted = await runOk<{ success: boolean; syncPending: boolean }>(vaultPath, [
    'icons',
    'delete',
    icon.id,
    '--yes'
  ])
  assert.deepEqual(deleted, { success: true, syncPending: false })
  await assert.rejects(fs.stat(icon.path))
  assert.equal((await run(vaultPath, ['icons', 'delete', icon.id, '--yes'])).code, 1)
  withDatabases(vaultPath, ({ dataDb }) => {
    assert.equal(dataDb.select().from(syncPendingDeletes).all().length, 0)
  })
})

test('icons delete of a synced icon records the row snapshot desktop replays as a delete', async () => {
  const vaultPath = await makeVault()
  const pngPath = path.join(vaultPath, 'dot.png')
  await fs.writeFile(pngPath, pngBytes(8, 8))
  const icon = await runOk<IconJson>(vaultPath, ['icons', 'add', pngPath])
  withDatabases(vaultPath, ({ dataDb }) => {
    dataDb
      .update(customIcons)
      .set({ clock: { device_1: 1 } })
      .where(eq(customIcons.id, icon.id))
      .run()
  })

  const deleted = await runOk<{ syncPending: boolean }>(vaultPath, [
    'icons',
    'delete',
    icon.id,
    '--yes'
  ])
  assert.equal(deleted.syncPending, true)
  withDatabases(vaultPath, ({ dataDb }) => {
    const [pending] = dataDb.select().from(syncPendingDeletes).all()
    assert.equal(pending.type, 'custom_icon')
    assert.equal(pending.itemId, icon.id)
    const snapshot = JSON.parse(pending.payload) as { id: string; name: string; data: string }
    assert.equal(snapshot.id, icon.id)
    assert.equal(snapshot.data, pngBytes(8, 8).toString('base64'))
  })
})
