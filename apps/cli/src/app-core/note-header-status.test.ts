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

test('a note with tasks shows the status they imply and keeps its stored one on disk', async () => {
  const vaultPath = await makeVault()
  const app = await createMemryApp({ vaultPath })
  try {
    await app.properties.createDefinition({ name: 'status', type: 'status' })
    const open = await app.tasks.create({ title: 'Open' })
    const finished = await app.tasks.create({ title: 'Finished' })
    await app.tasks.complete(finished.id)

    const note = await app.notes.create({
      title: 'Plan',
      content: `- [ ] Open {task:${open.id}}\n- [x] Finished {task:${finished.id}}`,
      properties: { status: 'Not started', owner: 'Kaan' }
    })
    assert.equal(note.properties.status, 'In Progress')
    assert.equal((await app.notes.get(note.id))?.properties.status, 'In Progress')

    await app.tasks.complete(open.id)
    assert.equal((await app.notes.get(note.id))?.properties.status, 'Done')

    const raw = await app.notes.get(note.id, { raw: true })
    assert.equal(raw?.properties.status, 'Not started')
    const file = matter(await fs.readFile(path.join(vaultPath, note.path), 'utf8'))
    assert.equal(file.data.status, 'Not started')
  } finally {
    app.close()
  }
})

test('renaming another property does not write the derived status into the file', async () => {
  const vaultPath = await makeVault()
  const app = await createMemryApp({ vaultPath })
  try {
    await app.properties.createDefinition({ name: 'status', type: 'status' })
    const task = await app.tasks.create({ title: 'Open' })
    await app.tasks.complete(task.id)
    const note = await app.notes.create({
      title: 'Plan',
      content: `- [x] Open {task:${task.id}}`,
      properties: { status: 'Not started', owner: 'Kaan' }
    })

    await app.properties.rename(note.id, 'owner', 'lead')

    const file = matter(await fs.readFile(path.join(vaultPath, note.path), 'utf8'))
    assert.equal(file.data.status, 'Not started')
    assert.equal(file.data.lead, 'Kaan')
  } finally {
    app.close()
  }
})

test('a note without tasks keeps its stored status', async () => {
  const vaultPath = await makeVault()
  const app = await createMemryApp({ vaultPath })
  try {
    await app.properties.createDefinition({ name: 'status', type: 'status' })
    const note = await app.notes.create({
      title: 'Idea',
      content: 'Just prose',
      properties: { status: 'Abandoned' }
    })
    assert.equal((await app.notes.get(note.id))?.properties.status, 'Abandoned')
  } finally {
    app.close()
  }
})

test('a status property the picker named Status follows the tasks too', async () => {
  const vaultPath = await makeVault()
  const app = await createMemryApp({ vaultPath })
  try {
    await app.properties.createDefinition({ name: 'Status', type: 'status' })
    const task = await app.tasks.create({ title: 'Open' })
    await app.tasks.complete(task.id)
    const note = await app.notes.create({
      title: 'Plan',
      content: `- [x] Open {task:${task.id}}`,
      properties: { Status: 'Not started' }
    })
    assert.equal((await app.notes.get(note.id))?.properties.Status, 'Done')
  } finally {
    app.close()
  }
})
