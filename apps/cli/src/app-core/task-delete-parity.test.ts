import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import test from 'node:test'

import { asc } from 'drizzle-orm'
import { syncIntents, taskActivity, tasks } from '@memry/db-schema/data-schema'

import { createTasksCommands } from '../../../../packages/domain-tasks/src/commands.ts'
import { openDatabases } from './database.ts'
import { createMemryApp } from './memry-app.ts'
import { runCli } from '../run.ts'

async function makeVault() {
  const root = path.join(process.cwd(), 'test-results', 'memry-cli-task-parity')
  await fs.mkdir(root, { recursive: true })
  const vaultPath = path.join(root, `vault-${process.pid}-${randomUUID()}`)
  await fs.mkdir(vaultPath)
  return vaultPath
}

async function cli(vaultPath: string, args: string[]) {
  const stdout: string[] = []
  const stderr: string[] = []
  const code = await runCli(['--vault', vaultPath, '--json', ...args], {
    stdout: (line) => stdout.push(line),
    stderr: (line) => stderr.push(line)
  })
  return { code, stdout: stdout.join('\n'), stderr: stderr.join('\n') }
}

function readIntents(vaultPath: string) {
  const databases = openDatabases(vaultPath)
  try {
    return databases.dataDb.select().from(syncIntents).orderBy(asc(syncIntents.seq)).all()
  } finally {
    databases.close()
  }
}

// What the desktop domain publishes, in order, for the same tree.
async function desktopDeleteOrder(
  rows: Array<{ id: string; parentId: string | null }>,
  id: string
): Promise<string[]> {
  const byId = new Map(rows.map((row) => [row.id, row]))
  const deleted: string[] = []
  const noop = async () => {}
  const commands = createTasksCommands({
    repository: {
      getTask: (taskId: string) => byId.get(taskId),
      getSubtasks: (parentId: string) => rows.filter((row) => row.parentId === parentId),
      deleteTask: () => {}
    } as never,
    publisher: {
      taskDeleted: async (event: { id: string }) => {
        deleted.push(event.id)
      },
      taskCreated: noop,
      taskUpdated: noop,
      taskCompleted: noop,
      taskMoved: noop,
      projectCreated: noop,
      projectUpdated: noop,
      projectDeleted: noop,
      statusCreated: noop,
      statusUpdated: noop,
      statusDeleted: noop
    },
    generateId: () => 'unused'
  })
  await commands.deleteTask(id)
  return deleted
}

test('tasks delete removes the whole subtask branch deepest first, one delete intent per row, like desktop', async () => {
  const vaultPath = await makeVault()
  const app = await createMemryApp({ vaultPath })
  let ids: Record<string, string>
  try {
    const root = await app.tasks.create({ title: 'root' })
    const a = await app.tasks.create({ title: 'a', parentId: root.id })
    const a1 = await app.tasks.create({ title: 'a1', parentId: a.id })
    const b = await app.tasks.create({ title: 'b', parentId: root.id })
    const lone = await app.tasks.create({ title: 'lone' })
    ids = { root: root.id, a: a.id, a1: a1.id, b: b.id, lone: lone.id }
  } finally {
    app.close()
  }

  const refused = await cli(vaultPath, ['tasks', 'delete', ids.root])
  assert.equal(refused.code, 1)
  assert.match(refused.stderr, /--yes/)

  const result = await cli(vaultPath, ['tasks', 'delete', ids.root, '--yes'])
  assert.equal(result.code, 0, result.stderr)

  const databases = openDatabases(vaultPath)
  try {
    const remaining = databases.dataDb.select({ id: tasks.id }).from(tasks).all()
    assert.deepEqual(
      remaining.map((row) => row.id),
      [ids.lone]
    )
  } finally {
    databases.close()
  }

  const intents = readIntents(vaultPath).filter((intent) => intent.op === 'delete')
  const expected = await desktopDeleteOrder(
    [
      { id: ids.root, parentId: null },
      { id: ids.a, parentId: ids.root },
      { id: ids.a1, parentId: ids.a },
      { id: ids.b, parentId: ids.root }
    ],
    ids.root
  )
  assert.deepEqual(
    intents.map((intent) => intent.itemId),
    expected
  )
  assert.equal(intents.length, 4)
  for (const intent of intents) {
    assert.equal(intent.type, 'task')
    const [snapshot] = JSON.parse(intent.args) as [string]
    assert.equal((JSON.parse(snapshot) as { id: string }).id, intent.itemId)
  }
})

test('tasks delete --keep-subtasks moves direct subtasks up one level, like the desktop drawer', async () => {
  const vaultPath = await makeVault()
  const app = await createMemryApp({ vaultPath })
  const top = await app.tasks.create({ title: 'top' })
  const mid = await app.tasks.create({ title: 'mid', parentId: top.id })
  const x = await app.tasks.create({ title: 'x', parentId: mid.id })
  const x1 = await app.tasks.create({ title: 'x1', parentId: x.id })
  app.close()

  {
    const result = await cli(vaultPath, ['tasks', 'delete', mid.id, '--yes', '--keep-subtasks'])
    assert.equal(result.code, 0, result.stderr)

    const reopened = await createMemryApp({ vaultPath })
    try {
      assert.equal(await reopened.tasks.get(mid.id), null)
      assert.equal((await reopened.tasks.get(x.id))?.parentId, top.id)
      assert.equal((await reopened.tasks.get(x1.id))?.parentId, x.id)
    } finally {
      reopened.close()
    }

    const intents = readIntents(vaultPath)
    assert.deepEqual(
      intents.map((intent) => [intent.itemId, intent.op]),
      [
        [x.id, 'update'],
        [mid.id, 'delete']
      ]
    )
    assert.deepEqual(JSON.parse(intents[0].args), [['parentId']])
  }
})

test('tasks bulk-delete cascades and tolerates a parent listed with its own subtask', async () => {
  const vaultPath = await makeVault()
  const app = await createMemryApp({ vaultPath })
  let parentId: string
  let childId: string
  try {
    const parent = await app.tasks.create({ title: 'parent' })
    const child = await app.tasks.create({ title: 'child', parentId: parent.id })
    const grand = await app.tasks.create({ title: 'grand', parentId: child.id })
    parentId = parent.id
    childId = child.id
    assert.ok(grand.id)
  } finally {
    app.close()
  }

  const refused = await cli(vaultPath, ['tasks', 'bulk-delete', parentId, childId])
  assert.equal(refused.code, 1)

  const result = await cli(vaultPath, ['tasks', 'bulk-delete', parentId, childId, '--yes'])
  assert.equal(result.code, 0, result.stderr)
  assert.deepEqual(JSON.parse(result.stdout), { count: 2 })

  const databases = openDatabases(vaultPath)
  try {
    assert.equal(databases.dataDb.select().from(tasks).all().length, 0)
  } finally {
    databases.close()
  }
  const intents = readIntents(vaultPath)
  assert.equal(intents.length, 3)
  assert.equal(new Set(intents.map((intent) => intent.itemId)).size, 3)
})

test('tasks reopen matches desktop uncomplete: clears completedAt and leaves the status alone', async () => {
  const vaultPath = await makeVault()
  const app = await createMemryApp({ vaultPath })
  try {
    const task = await app.tasks.create({ title: 'finish me' })
    const done = await app.tasks.complete(task.id)
    assert.ok(done.completedAt)
    const reopened = await app.tasks.reopen(task.id)
    assert.equal(reopened.completedAt, null)
    assert.equal(reopened.statusId, task.statusId)
    assert.equal(reopened.archivedAt, null)
  } finally {
    app.close()
  }
})

test('tasks create and update take --duration, --link-canvas and --field', async () => {
  const vaultPath = await makeVault()
  const created = await cli(vaultPath, [
    'tasks',
    'create',
    'Plan trip',
    '--duration',
    '45',
    '--link-canvas',
    'canvas-1',
    '--field',
    'effort=3',
    '--field',
    'owner=Kaan',
    '--field',
    'skipped=null'
  ])
  assert.equal(created.code, 0, created.stderr)
  const task = JSON.parse(created.stdout)
  assert.equal(task.durationMinutes, 45)
  assert.deepEqual(task.linkedCanvasIds, ['canvas-1'])
  assert.deepEqual(task.fields, { effort: 3, owner: 'Kaan' })

  const updated = await cli(vaultPath, [
    'tasks',
    'update',
    task.id,
    '--field',
    'effort=5',
    '--field',
    'owner=null',
    '--duration',
    '90'
  ])
  assert.equal(updated.code, 0, updated.stderr)
  const after = JSON.parse(updated.stdout)
  assert.equal(after.durationMinutes, 90)
  assert.deepEqual(after.fields, { effort: 5 })

  const cleared = await cli(vaultPath, ['tasks', 'update', task.id, '--duration', 'null'])
  assert.equal(JSON.parse(cleared.stdout).durationMinutes, null)

  const bad = await cli(vaultPath, ['tasks', 'update', task.id, '--duration', '0'])
  assert.equal(bad.code, 1)
  assert.match(bad.stderr, /--duration/)
  const badField = await cli(vaultPath, ['tasks', 'update', task.id, '--field', 'novalue'])
  assert.equal(badField.code, 1)
  assert.match(badField.stderr, /name=value/)
})

test('tasks activity lists the synced audit log newest first with names resolved', async () => {
  const vaultPath = await makeVault()
  const app = await createMemryApp({ vaultPath })
  let taskId: string
  let projectName: string
  try {
    const project = await app.tasks.projects.create({ name: 'Garden' })
    const task = await app.tasks.create({ title: 'Water plants' })
    taskId = task.id
    projectName = project.name
    const databases = openDatabases(vaultPath)
    try {
      databases.dataDb
        .insert(taskActivity)
        .values([
          { id: 'act-1', taskId, action: 'created', createdAt: '2026-10-01T10:00:00.000Z' },
          {
            id: 'act-2',
            taskId,
            action: 'updated',
            field: 'projectId',
            oldValue: JSON.stringify(task.projectId),
            newValue: JSON.stringify(project.id),
            createdAt: '2026-10-02T10:00:00.000Z'
          },
          { id: 'act-3', taskId: 'other', action: 'created', createdAt: '2026-10-03T10:00:00.000Z' }
        ])
        .run()
    } finally {
      databases.close()
    }
  } finally {
    app.close()
  }

  const result = await cli(vaultPath, ['tasks', 'activity', taskId])
  assert.equal(result.code, 0, result.stderr)
  const page = JSON.parse(result.stdout)
  assert.equal(page.total, 2)
  assert.equal(page.hasMore, false)
  assert.deepEqual(
    page.entries.map((entry: { id: string }) => entry.id),
    ['act-2', 'act-1']
  )
  assert.equal(page.entries[0].newValue, JSON.stringify(projectName))

  const filtered = await cli(vaultPath, [
    'tasks',
    'activity',
    taskId,
    '--action',
    'created',
    '--limit',
    '1'
  ])
  assert.deepEqual(
    JSON.parse(filtered.stdout).entries.map((entry: { id: string }) => entry.id),
    ['act-1']
  )
})
