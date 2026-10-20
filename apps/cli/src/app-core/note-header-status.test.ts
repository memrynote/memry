import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import test from 'node:test'
import matter from 'gray-matter'

import { createMemryApp } from './memry-app.ts'

async function makeVault() {
  const root = path.join(process.cwd(), 'test-results', 'memry-cli-header-status')
  await fs.mkdir(root, { recursive: true })
  const vaultPath = path.join(root, `vault-${process.pid}-${randomUUID()}`)
  await fs.mkdir(path.join(vaultPath, '.memry'), { recursive: true })
  return vaultPath
}

const stored = async (vaultPath: string, notePath: string, key = 'status') =>
  matter(await fs.readFile(path.join(vaultPath, notePath), 'utf8')).data[key]

/** A note holding two tasks written in its body, each sourced from the note as an editor-made task is. */
async function noteWithTasks(vaultPath: string, name = 'status') {
  const app = await createMemryApp({ vaultPath })
  await app.properties.createDefinition({ name, type: 'status' })
  const note = await app.notes.create({
    title: 'Plan',
    content: 'Plan',
    properties: { [name]: 'Abandoned', owner: 'Kaan' }
  })
  const a = await app.tasks.create({ title: 'A', sourceNoteId: note.id })
  const b = await app.tasks.create({ title: 'B', sourceNoteId: note.id })
  await app.notes.update({
    id: note.id,
    content: `- [ ] A {task:${a.id}}\n- [ ] B {task:${b.id}}`
  })
  return { app, a, b, note }
}

test('completing the tasks in a note writes the status they imply into the file', async () => {
  const vaultPath = await makeVault()
  const { app, a, b, note } = await noteWithTasks(vaultPath)
  try {
    await app.tasks.complete(a.id)
    assert.equal(await stored(vaultPath, note.path), 'In Progress')
    assert.equal((await app.notes.get(note.id))?.properties.status, 'In Progress')

    await app.tasks.complete(b.id)
    assert.equal(await stored(vaultPath, note.path), 'Done')
    assert.equal(await stored(vaultPath, note.path, 'owner'), 'Kaan')

    await app.tasks.reopen(a.id)
    assert.equal(await stored(vaultPath, note.path), 'In Progress')
  } finally {
    app.close()
  }
})

test('a status the user sets stays until a task changes again', async () => {
  const vaultPath = await makeVault()
  const { app, a, b, note } = await noteWithTasks(vaultPath)
  try {
    await app.tasks.complete(a.id)
    await app.tasks.complete(b.id)
    await app.properties.set(note.id, { status: 'In Progress', owner: 'Kaan' })
    assert.equal(await stored(vaultPath, note.path), 'In Progress')

    await app.tasks.update(a.id, { title: 'Renamed' })
    assert.equal(
      await stored(vaultPath, note.path),
      'In Progress',
      'a title edit is no status change'
    )

    await app.tasks.reopen(b.id)
    await app.tasks.complete(b.id)
    assert.equal(await stored(vaultPath, note.path), 'Done', 'a task change writes over the pick')
  } finally {
    app.close()
  }
})

test('a status property the picker named Status follows the tasks too', async () => {
  const vaultPath = await makeVault()
  const { app, a, b, note } = await noteWithTasks(vaultPath, 'Status')
  try {
    await app.tasks.complete(a.id)
    await app.tasks.complete(b.id)
    assert.equal(await stored(vaultPath, note.path, 'Status'), 'Done')
  } finally {
    app.close()
  }
})

test('a note without tasks, or whose status is another type, keeps its value', async () => {
  const vaultPath = await makeVault()
  const app = await createMemryApp({ vaultPath })
  try {
    await app.properties.createDefinition({ name: 'status', type: 'select' })
    const note = await app.notes.create({
      title: 'Plan',
      content: 'Plan',
      properties: { status: 'Open' }
    })
    const task = await app.tasks.create({ title: 'A', sourceNoteId: note.id })
    await app.notes.update({ id: note.id, content: `- [ ] A {task:${task.id}}` })
    await app.tasks.complete(task.id)
    assert.equal(await stored(vaultPath, note.path), 'Open')

    const idea = await app.notes.create({
      title: 'Idea',
      content: 'Prose',
      properties: { status: 'Abandoned' }
    })
    await app.tasks.create({ title: 'Elsewhere' })
    assert.equal(await stored(vaultPath, idea.path), 'Abandoned')
  } finally {
    app.close()
  }
})
