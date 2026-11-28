import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import test from 'node:test'

import { runCli } from './run.ts'

const testRoot = path.join(process.cwd(), 'test-results', 'memry-cli-template-names')

async function makeVault(): Promise<string> {
  const vaultPath = path.join(testRoot, `vault-${process.pid}-${randomUUID()}`)
  await fs.mkdir(vaultPath, { recursive: true })
  return vaultPath
}

async function cli(vaultPath: string, ...args: string[]) {
  const stdout: string[] = []
  const stderr: string[] = []
  const code = await runCli(['--vault', vaultPath, ...args], {
    stdout: (line) => stdout.push(line),
    stderr: (line) => stderr.push(line)
  })
  return { code, stdout: stdout.join('\n'), stderr: stderr.join('\n') }
}

async function names(vaultPath: string): Promise<string[]> {
  const listed = await cli(vaultPath, '--json', 'templates', 'list')
  assert.equal(listed.code, 0, listed.stderr)
  return (JSON.parse(listed.stdout) as Array<{ name: string }>).map((t) => t.name).toSorted()
}

test('templates create refuses a name another template has, ignoring case and spacing', async () => {
  const vaultPath = await makeVault()
  const first = await cli(vaultPath, '--json', 'templates', 'create', 'Standup')
  assert.equal(first.code, 0, first.stderr)

  for (const json of [[], ['--json']]) {
    const clash = await cli(vaultPath, ...json, 'templates', 'create', '  standup ')
    assert.equal(clash.code, 1)
    assert.equal(clash.stdout, '')
    assert.equal(
      clash.stderr,
      'A template named "standup" already exists. Choose a different name.'
    )
  }

  const builtIn = await cli(vaultPath, 'templates', 'create', 'meeting   NOTES')
  assert.equal(builtIn.code, 1)
  assert.match(builtIn.stderr, /already exists/)

  assert.deepEqual(await names(vaultPath), ['Standup'])
})

test('templates update refuses a rename onto a taken name but keeps its own name editable', async () => {
  const vaultPath = await makeVault()
  await cli(vaultPath, 'templates', 'create', 'Standup')
  const created = await cli(vaultPath, '--json', 'templates', 'create', 'Retro')
  const retro = JSON.parse(created.stdout) as { id: string }

  const clash = await cli(vaultPath, '--json', 'templates', 'update', retro.id, '--name', 'STANDUP')
  assert.equal(clash.code, 1)
  assert.equal(clash.stdout, '')
  assert.match(clash.stderr, /A template named "STANDUP" already exists/)

  const builtIn = await cli(vaultPath, 'templates', 'update', retro.id, '--name', 'Weekly Review')
  assert.equal(builtIn.code, 1)

  const recase = await cli(vaultPath, '--json', 'templates', 'update', retro.id, '--name', 'retro')
  assert.equal(recase.code, 0, recase.stderr)
  assert.equal((JSON.parse(recase.stdout) as { name: string }).name, 'retro')

  assert.deepEqual(await names(vaultPath), ['Standup', 'retro'])
})

test('templates duplicate numbers the copy past every taken name', async () => {
  const vaultPath = await makeVault()
  const created = await cli(vaultPath, '--json', 'templates', 'create', 'Standup')
  const standup = JSON.parse(created.stdout) as { id: string }

  for (const expected of ['standup 2', 'standup 3']) {
    const copy = await cli(vaultPath, '--json', 'templates', 'duplicate', standup.id, ' standup ')
    assert.equal(copy.code, 0, copy.stderr)
    assert.equal((JSON.parse(copy.stdout) as { name: string }).name, expected)
  }

  const onBuiltIn = await cli(
    vaultPath,
    '--json',
    'templates',
    'duplicate',
    standup.id,
    'Blank Note'
  )
  assert.equal(onBuiltIn.code, 0, onBuiltIn.stderr)
  assert.equal((JSON.parse(onBuiltIn.stdout) as { name: string }).name, 'Blank Note 2')

  assert.deepEqual(await names(vaultPath), ['Blank Note 2', 'Standup', 'standup 2', 'standup 3'])
})
