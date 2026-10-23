import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import test from 'node:test'
import matter from 'gray-matter'

import { createMemryApp } from './memry-app.ts'

async function makeVault() {
  const root = path.join(process.cwd(), 'test-results', 'memry-cli-properties')
  await fs.mkdir(root, { recursive: true })
  const vaultPath = path.join(root, `vault-${process.pid}-${randomUUID()}`)
  await fs.mkdir(path.join(vaultPath, '.memry'), { recursive: true })
  return vaultPath
}

const propertiesFile = (vaultPath: string) => path.join(vaultPath, '.memry', 'properties.md')

test('definition writes keep properties.md entries the CLI does not own', async () => {
  const vaultPath = await makeVault()
  const desktopEntries = {
    rating: { type: 'number', color: 'amber' },
    due: { type: 'date', showOnCalendar: true },
    future: { type: 'hologram', depth: 3 },
    broken: { type: 'select', options: 'not-an-array' }
  }
  await fs.writeFile(
    propertiesFile(vaultPath),
    matter.stringify('', { properties: desktopEntries })
  )
  const app = await createMemryApp({ vaultPath })
  try {
    await app.properties.createDefinition({
      name: 'mood',
      type: 'select',
      options: JSON.stringify([{ value: 'Calm', color: 'sky' }])
    })
    let written = matter(await fs.readFile(propertiesFile(vaultPath), 'utf8')).data.properties
    assert.deepEqual(written, {
      ...desktopEntries,
      mood: { type: 'select', options: [{ value: 'Calm', color: 'sky' }] }
    })

    await app.properties.deleteDefinition('mood')
    written = matter(await fs.readFile(propertiesFile(vaultPath), 'utf8')).data.properties
    assert.deepEqual(written, desktopEntries)
  } finally {
    app.close()
  }
})

test('definition writes leave an unreadable properties.md untouched', async () => {
  const vaultPath = await makeVault()
  const raw = '---\nproperties: [not, a, map]\n---\n'
  await fs.writeFile(propertiesFile(vaultPath), raw)
  const app = await createMemryApp({ vaultPath })
  try {
    await app.properties.createDefinition({ name: 'mood', type: 'select', options: '[]' })
    assert.equal(await fs.readFile(propertiesFile(vaultPath), 'utf8'), raw)
  } finally {
    app.close()
  }
})

test('definitions with an unknown type are rejected and never reach properties.md', async () => {
  const vaultPath = await makeVault()
  const app = await createMemryApp({ vaultPath })
  try {
    await assert.rejects(
      app.properties.createDefinition({ name: 'bogus', type: 'not-a-type' }),
      /Unknown property type: not-a-type\. Allowed types: text, number/
    )
    await app.properties.createDefinition({ name: 'mood', type: 'text' })
    await assert.rejects(
      app.properties.updateDefinition('mood', { type: 'not-a-type' }),
      /Unknown property type/
    )
    assert.deepEqual(
      (await app.properties.definitions()).map((d) => [d.name, d.type]),
      [['mood', 'text']]
    )
    const written = matter(await fs.readFile(propertiesFile(vaultPath), 'utf8')).data.properties
    assert.deepEqual(Object.keys(written), ['mood'])
  } finally {
    app.close()
  }
})

test('a write that fails partway leaves the old properties.md intact', async (t) => {
  const vaultPath = await makeVault()
  const original = matter.stringify('', { properties: { rating: { type: 'number' } } })
  await fs.writeFile(propertiesFile(vaultPath), original)
  const app = await createMemryApp({ vaultPath })
  // Simulate a crash mid-write: half the bytes reach the file, then the write fails.
  const realWriteFile = fs.writeFile
  t.mock.method(fs, 'writeFile', async (file: string, data: string) => {
    await realWriteFile(file, data.slice(0, Math.floor(data.length / 2)))
    throw new Error('simulated crash')
  })
  try {
    await assert.rejects(
      app.properties.createDefinition({ name: 'mood', type: 'text' }),
      /simulated crash/
    )
  } finally {
    t.mock.restoreAll()
    app.close()
  }
  assert.equal(await fs.readFile(propertiesFile(vaultPath), 'utf8'), original)
  const leftovers = (await fs.readdir(path.join(vaultPath, '.memry'))).filter((f) =>
    f.endsWith('.tmp')
  )
  assert.deepEqual(leftovers, [])
})
