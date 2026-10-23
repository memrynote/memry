import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import test from 'node:test'

import {
  canvasAssets,
  canvasEntityEdges,
  canvasEntityRefs,
  canvases
} from '@memry/db-schema/data-schema'
import { eq } from 'drizzle-orm'

import { runCli } from '../run.ts'
import { openDatabases } from './database.ts'

async function makeVault() {
  const root = path.join(process.cwd(), 'test-results', 'memry-cli-canvas')
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

interface CanvasJson {
  id: string
  title: string | null
  folder: string | null
  icon: string | null
  scene: string
  itemCount?: number
  unreadable?: boolean
}

// Two note cards joined by an arrow that points from B to A (head at the start only).
const SCENE = JSON.stringify({
  type: 'excalidraw',
  version: 2,
  source: 'test',
  elements: [
    { id: 'a', type: 'rectangle', customData: { entityType: 'note', entityId: 'n1' } },
    { id: 'b', type: 'rectangle', customData: { entityType: 'task', entityId: 't1' } },
    {
      id: 'gone',
      type: 'rectangle',
      isDeleted: true,
      customData: { entityType: 'note', entityId: 'n9' }
    },
    { id: 'plain', type: 'rectangle' },
    {
      id: 'arrow',
      type: 'arrow',
      startBinding: { elementId: 'a' },
      endBinding: { elementId: 'b' },
      startArrowhead: 'arrow',
      endArrowhead: null
    }
  ],
  appState: {},
  files: {}
})

test('canvas create writes a .excalidraw document with the memry sidecar and indexes its cards', async () => {
  const vaultPath = await makeVault()
  const scenePath = path.join(vaultPath, 'scene-input.json')
  await fs.writeFile(scenePath, SCENE)

  const created = await runOk<CanvasJson>(vaultPath, [
    'canvas',
    'create',
    '--title',
    'Plan',
    '--folder',
    'Work/Q3',
    '--icon',
    'rocket',
    '--scene-file',
    scenePath
  ])
  assert.equal(created.title, 'Plan')
  assert.equal(created.folder, 'Work/Q3')
  assert.equal(created.icon, 'rocket')

  const file = path.join(vaultPath, 'canvases', 'Work', 'Q3', 'Plan.excalidraw')
  const document = JSON.parse(await fs.readFile(file, 'utf8')) as Record<string, unknown>
  assert.equal((document.memry as { id: string }).id, created.id)
  assert.deepEqual(Object.keys(document).slice(0, 5), [
    'type',
    'version',
    'source',
    'memry',
    'elements'
  ])

  withDatabases(vaultPath, ({ dataDb }) => {
    const row = dataDb.select().from(canvases).where(eq(canvases.id, created.id)).get()
    assert.equal(row?.clock, null, 'a clock-less row is what desktop sync seeds on its next start')
    assert.equal(row?.filePath, 'canvases/Work/Q3/Plan.excalidraw')
    const refs = dataDb
      .select()
      .from(canvasEntityRefs)
      .where(eq(canvasEntityRefs.canvasId, created.id))
      .all()
    assert.deepEqual(refs.map((ref) => `${ref.entityType}:${ref.entityId}`).sort(), [
      'note:n1',
      'task:t1'
    ])
    const edges = dataDb
      .select()
      .from(canvasEntityEdges)
      .where(eq(canvasEntityEdges.canvasId, created.id))
      .all()
    assert.equal(edges.length, 1)
    // The only arrowhead is at the start, so the edge points task -> note.
    assert.equal(edges[0].sourceId, 't1')
    assert.equal(edges[0].targetId, 'n1')
  })
})

test('canvas list, get and export round-trip the scene without the sidecar', async () => {
  const vaultPath = await makeVault()
  const scenePath = path.join(vaultPath, 'scene-input.json')
  await fs.writeFile(scenePath, SCENE)
  const created = await runOk<CanvasJson>(vaultPath, [
    'canvas',
    'create',
    '--title',
    'Map',
    '--scene-file',
    scenePath
  ])

  const listed = await runOk<CanvasJson[]>(vaultPath, ['canvas', 'list'])
  assert.equal(listed.length, 1)
  assert.equal(listed[0].itemCount, 2)
  assert.equal(listed[0].unreadable, false)
  assert.deepEqual(await runOk<CanvasJson[]>(vaultPath, ['canvas', 'list', '--folder', 'Nope']), [])

  const fetched = await runOk<CanvasJson>(vaultPath, ['canvas', 'get', created.id])
  assert.equal('memry' in JSON.parse(fetched.scene), false)
  assert.equal((JSON.parse(fetched.scene) as { elements: unknown[] }).elements.length, 5)

  const summary = await runOk<CanvasJson>(vaultPath, ['canvas', 'get', created.id, '--no-scene'])
  assert.equal('scene' in summary, false)

  const target = path.join(vaultPath, 'out.excalidraw')
  await runOk(vaultPath, ['canvas', 'export', created.id, '--out', target])
  const exported = JSON.parse(await fs.readFile(target, 'utf8')) as Record<string, unknown>
  assert.equal(exported.type, 'excalidraw')
  assert.equal('memry' in exported, false)

  const again = await run(vaultPath, ['canvas', 'export', created.id, '--out', target])
  assert.equal(again.code, 1)
  assert.match(again.stderr, /Refusing to overwrite/)
})

test('canvas create rejects a scene that is not JSON and leaves no file behind', async () => {
  const vaultPath = await makeVault()
  const scenePath = path.join(vaultPath, 'bad.json')
  await fs.writeFile(scenePath, '{nope')
  const result = await run(vaultPath, [
    'canvas',
    'create',
    '--title',
    'Bad',
    '--scene-file',
    scenePath
  ])
  assert.equal(result.code, 1)
  assert.match(result.stderr, /not valid JSON/)
  await assert.rejects(fs.stat(path.join(vaultPath, 'canvases', 'Bad.excalidraw')))
})

test('canvas duplicate names the copy beside the original and copies asset rows', async () => {
  const vaultPath = await makeVault()
  const original = await runOk<CanvasJson>(vaultPath, [
    'canvas',
    'create',
    '--title',
    'Plan',
    '--icon',
    'star'
  ])
  withDatabases(vaultPath, ({ dataDb }) => {
    const row = dataDb.select().from(canvases).where(eq(canvases.id, original.id)).get()
    dataDb
      .insert(canvasAssets)
      .values({
        vaultId: row!.vaultId,
        canvasId: original.id,
        contentHash: 'hash1',
        attachmentId: 'att1',
        fileId: 'f1',
        filename: 'a.png',
        mimeType: 'image/png',
        sizeBytes: 3,
        chunkHashes: ['c1'],
        createdAt: 1
      })
      .run()
  })

  const copy = await runOk<CanvasJson>(vaultPath, ['canvas', 'duplicate', original.id])
  assert.notEqual(copy.id, original.id)
  assert.equal(copy.title, 'Plan 2')
  assert.equal(copy.icon, 'star')
  await fs.stat(path.join(vaultPath, 'canvases', 'Plan 2.excalidraw'))
  withDatabases(vaultPath, ({ dataDb }) => {
    assert.equal(
      dataDb.select().from(canvasAssets).where(eq(canvasAssets.canvasId, copy.id)).all().length,
      1
    )
  })

  const missing = await run(vaultPath, ['canvas', 'duplicate', 'nope'])
  assert.equal(missing.code, 1)
})

test('canvas delete needs --yes, tombstones a never-synced canvas and removes its document', async () => {
  const vaultPath = await makeVault()
  const created = await runOk<CanvasJson>(vaultPath, ['canvas', 'create', '--title', 'Temp'])
  const file = path.join(vaultPath, 'canvases', 'Temp.excalidraw')

  const refused = await run(vaultPath, ['canvas', 'delete', created.id])
  assert.equal(refused.code, 1)
  assert.match(refused.stderr, /--yes/)
  await fs.stat(file)

  const result = await runOk<{ deleted: boolean; syncPending: boolean }>(vaultPath, [
    'canvas',
    'delete',
    created.id,
    '--yes'
  ])
  assert.deepEqual(result, { deleted: true, syncPending: false })
  await assert.rejects(fs.stat(file))
  assert.deepEqual(await runOk<CanvasJson[]>(vaultPath, ['canvas', 'list']), [])
  withDatabases(vaultPath, ({ dataDb }) => {
    assert.notEqual(
      dataDb.select().from(canvases).where(eq(canvases.id, created.id)).get()?.deletedAt,
      null
    )
  })
  assert.equal((await run(vaultPath, ['canvas', 'get', created.id])).code, 1)
})

test('canvas delete of a synced canvas removes only the document so desktop can sync the delete', async () => {
  const vaultPath = await makeVault()
  const created = await runOk<CanvasJson>(vaultPath, ['canvas', 'create', '--title', 'Shared'])
  withDatabases(vaultPath, ({ dataDb }) => {
    dataDb
      .update(canvases)
      .set({ clock: { device_1: 1 } })
      .where(eq(canvases.id, created.id))
      .run()
  })

  const result = await runOk<{ deleted: boolean; syncPending: boolean }>(vaultPath, [
    'canvas',
    'delete',
    created.id,
    '--yes'
  ])
  assert.deepEqual(result, { deleted: true, syncPending: true })
  withDatabases(vaultPath, ({ dataDb }) => {
    assert.equal(
      dataDb.select().from(canvases).where(eq(canvases.id, created.id)).get()?.deletedAt,
      null
    )
  })
  const listed = await runOk<CanvasJson[]>(vaultPath, ['canvas', 'list'])
  assert.equal(
    listed[0].unreadable,
    true,
    'the row stays listed as unreadable until desktop tombstones it'
  )
})
