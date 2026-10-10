import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { listTreeFolders } from './folders.ts'
import { ensureVaultLayout, getConfigPath } from './paths.ts'

async function vaultWithConfig(config: unknown, folders: string[]): Promise<string> {
  const vaultPath = await fs.mkdtemp(path.join(os.tmpdir(), 'memry-cli-config-'))
  await fs.mkdir(path.join(vaultPath, '.memry'), { recursive: true })
  await fs.writeFile(getConfigPath(vaultPath), JSON.stringify(config), 'utf-8')
  for (const folder of folders) await fs.mkdir(path.join(vaultPath, folder), { recursive: true })
  return vaultPath
}

async function listedFolders(config: unknown, folders: string[]): Promise<string[]> {
  const vaultPath = await vaultWithConfig(config, folders)
  const listed = await listTreeFolders(vaultPath, await ensureVaultLayout(vaultPath))
  return listed.filter((folder) => folders.includes(folder)).sort()
}

// Expected lists are what desktop's getConfig + createTreeFolderFilter produce
// for the same config.json.
test('journalFolder is normalized like desktop', async () => {
  assert.deepEqual(
    await listedFolders({ journalFolder: 'Notes//Daily' }, ['Notes', 'Notes/Daily', 'Notes/Other']),
    ['Notes', 'Notes/Other']
  )
  assert.deepEqual(await listedFolders({ journalFolder: ' Daily ' }, ['Daily', 'Work']), ['Work'])
})

test('excludePatterns match desktop: only a trailing slash is stripped', async () => {
  assert.deepEqual(await listedFolders({ excludePatterns: ['/x'] }, ['x', 'y']), ['x', 'y'])
  assert.deepEqual(await listedFolders({ excludePatterns: ['x\\y'] }, ['x', 'x/y']), ['x', 'x/y'])
  assert.deepEqual(await listedFolders({ excludePatterns: ['x/'] }, ['x', 'y']), ['y'])
})

test('journalShowInSidebar is on only for the boolean true', async () => {
  assert.deepEqual(
    await listedFolders({ journalFolder: 'journal', journalShowInSidebar: 'false' }, [
      'journal',
      'a'
    ]),
    ['a']
  )
  assert.deepEqual(
    await listedFolders({ journalFolder: 'journal', journalShowInSidebar: true }, ['journal', 'a']),
    ['a', 'journal']
  )
})

test('a corrupt config.json is reported and left untouched', async (t) => {
  const vaultPath = await fs.mkdtemp(path.join(os.tmpdir(), 'memry-cli-config-'))
  await fs.mkdir(path.join(vaultPath, '.memry'), { recursive: true })
  const configPath = getConfigPath(vaultPath)
  await fs.writeFile(configPath, '{ not json', 'utf-8')
  const warn = t.mock.method(console, 'error', () => {})

  const config = await ensureVaultLayout(vaultPath)

  assert.equal(await fs.readFile(configPath, 'utf-8'), '{ not json')
  assert.equal(config.journalFolder, 'journal')
  assert.equal(warn.mock.callCount(), 1)
  assert.match(
    String(warn.mock.calls[0].arguments.join(' ')),
    new RegExp(configPath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
  )
})

test('a missing config.json is created with defaults', async () => {
  const vaultPath = await fs.mkdtemp(path.join(os.tmpdir(), 'memry-cli-config-'))
  await ensureVaultLayout(vaultPath)
  const written = JSON.parse(await fs.readFile(getConfigPath(vaultPath), 'utf-8'))
  assert.equal(written.journalFolder, 'journal')
})

test('the journal folder is created under its normalized name', async () => {
  const vaultPath = await vaultWithConfig({ journalFolder: ' Daily ' }, [])
  await ensureVaultLayout(vaultPath)
  const entries = await fs.readdir(vaultPath)
  assert.ok(entries.includes('Daily'))
  assert.ok(!entries.includes(' Daily '))
})
