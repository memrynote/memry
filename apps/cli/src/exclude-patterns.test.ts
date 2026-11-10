import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import test, { type TestContext } from 'node:test'

import { getConfigPath } from './app-core/paths.ts'
import { runCli } from './run.ts'

// #4121: the desktop reads `excludePatterns` in .memry/config.json as the user's
// list and keeps it while the file gives none (#4119). The CLI must neither widen
// to the defaults on a config it cannot read nor write defaults the user never set.

async function makeVault(config: string | null, folders: string[] = []): Promise<string> {
  const root = path.join(process.cwd(), 'test-results', 'memry-cli-exclude')
  const vaultPath = path.join(root, `vault-${process.pid}-${randomUUID()}`)
  await fs.mkdir(path.join(vaultPath, '.memry'), { recursive: true })
  if (config !== null) await fs.writeFile(getConfigPath(vaultPath), config, 'utf-8')
  for (const folder of folders) await fs.mkdir(path.join(vaultPath, folder), { recursive: true })
  return vaultPath
}

async function cli(t: TestContext, vaultPath: string, ...args: string[]) {
  // The unreadable-config warning goes to process.stderr; keep test output clean.
  t.mock.method(process.stderr, 'write', () => true)
  const stdout: string[] = []
  const stderr: string[] = []
  const code = await runCli(['--vault', vaultPath, '--json', ...args], {
    stdout: (line) => stdout.push(line),
    stderr: (line) => stderr.push(line)
  })
  return { code, stdout, stderr: stderr.join('\n') }
}

const readConfig = async (vaultPath: string): Promise<Record<string, unknown>> =>
  JSON.parse(await fs.readFile(getConfigPath(vaultPath), 'utf-8')) as Record<string, unknown>

test('folders list fails instead of showing excluded folders when config.json is unreadable', async (t) => {
  const vaultPath = await makeVault('{ not json', ['private', 'notes'])

  const result = await cli(t, vaultPath, 'folders', 'list')

  assert.equal(result.code, 1, result.stdout.join('\n'))
  assert.match(result.stderr, /config\.json cannot be read/)
  assert.equal(await fs.readFile(getConfigPath(vaultPath), 'utf-8'), '{ not json')
})

test('vault update-config refuses to overwrite an unreadable config.json', async (t) => {
  const vaultPath = await makeVault('{ not json')

  const result = await cli(t, vaultPath, 'vault', 'update-config', '{"defaultNoteFolder":"inbox"}')

  assert.equal(result.code, 1)
  assert.match(result.stderr, /config\.json cannot be read/)
  assert.equal(await fs.readFile(getConfigPath(vaultPath), 'utf-8'), '{ not json')
})

test('folders list fails safe on an excludePatterns that is not a list', async (t) => {
  const vaultPath = await makeVault('{"excludePatterns":"private"}', ['private', 'notes'])

  const result = await cli(t, vaultPath, 'folders', 'list')

  assert.equal(result.code, 1, result.stdout.join('\n'))
  assert.match(result.stderr, /excludePatterns/)
  assert.equal((await readConfig(vaultPath)).excludePatterns, 'private')
})

test('a missing config.json is created without excludePatterns', async (t) => {
  const vaultPath = await makeVault(null)

  const result = await cli(t, vaultPath, 'vault', 'config')

  assert.equal(result.code, 0, result.stderr)
  const written = await readConfig(vaultPath)
  assert.equal(written.journalFolder, 'journal')
  assert.ok(!('excludePatterns' in written), JSON.stringify(written))
})

test('opening and updating a config without excludePatterns never writes the defaults', async (t) => {
  const vaultPath = await makeVault('{"journalFolder":"daily"}')

  assert.equal((await cli(t, vaultPath, 'vault', 'config')).code, 0)
  assert.ok(!('excludePatterns' in (await readConfig(vaultPath))))

  const updated = await cli(t, vaultPath, 'vault', 'update-config', '{"defaultNoteFolder":"inbox"}')
  assert.equal(updated.code, 0, updated.stderr)
  const written = await readConfig(vaultPath)
  assert.equal(written.defaultNoteFolder, 'inbox')
  assert.ok(!('excludePatterns' in written), JSON.stringify(written))
})

test('update-config keeps the user excludePatterns and writes the ones it is given', async (t) => {
  const vaultPath = await makeVault('{"excludePatterns":["private"]}', ['private', 'notes'])

  const updated = await cli(t, vaultPath, 'vault', 'update-config', '{"defaultNoteFolder":"inbox"}')
  assert.equal(updated.code, 0, updated.stderr)
  assert.deepEqual((await readConfig(vaultPath)).excludePatterns, ['private'])

  const listed = await cli(t, vaultPath, 'folders', 'list')
  const paths = (JSON.parse(listed.stdout.at(-1) ?? '[]') as Array<{ path: string }>).map(
    (f) => f.path
  )
  assert.ok(!paths.includes('private') && paths.includes('notes'), JSON.stringify(paths))

  const set = await cli(t, vaultPath, 'vault', 'update-config', '{"excludePatterns":["tmp"]}')
  assert.equal(set.code, 0, set.stderr)
  assert.deepEqual((await readConfig(vaultPath)).excludePatterns, ['tmp'])
})
