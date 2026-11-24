import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import test from 'node:test'

import { runCli } from './run.ts'

const testRoot = path.join(process.cwd(), 'test-results', 'memry-cli-folder-delete')
await fs.mkdir(testRoot, { recursive: true })

async function fileSystemIgnoresCase(): Promise<boolean> {
  const probe = path.join(testRoot, `CaseProbe-${randomUUID()}`)
  await fs.writeFile(probe, '')
  try {
    return await fs.access(path.join(testRoot, path.basename(probe).toLowerCase())).then(
      () => true,
      () => false
    )
  } finally {
    await fs.rm(probe)
  }
}

async function makeVault(): Promise<string> {
  const vaultPath = path.join(testRoot, `vault-${process.pid}-${randomUUID()}`)
  await fs.mkdir(path.join(vaultPath, 'SuperNotes', 'Sub'), { recursive: true })
  await fs.writeFile(path.join(vaultPath, 'SuperNotes', 'real.md'), '# Real\n')
  await fs.writeFile(path.join(vaultPath, 'SuperNotes', 'Sub', 'child.md'), '# Child\n')
  return vaultPath
}

async function deleteFolder(vaultPath: string, folder: string) {
  const stdout: string[] = []
  const stderr: string[] = []
  const code = await runCli(
    ['--vault', vaultPath, '--json', 'folders', 'delete', folder, '--yes'],
    {
      stdout: (line) => stdout.push(line),
      stderr: (line) => stderr.push(line)
    }
  )
  return { code, stdout, stderr: stderr.join('\n') }
}

async function listFiles(vaultPath: string): Promise<string[]> {
  const entries = await fs.readdir(path.join(vaultPath, 'SuperNotes'), { recursive: true })
  return entries.map((entry) => entry.replaceAll('\\', '/')).toSorted()
}

test(
  'folders delete refuses a path the disk spells differently and deletes nothing',
  { skip: !(await fileSystemIgnoresCase()) && 'case-sensitive file system' },
  async () => {
    const vaultPath = await makeVault()
    for (const folder of ['supernotes', 'SuperNotes/sub', 'SUPERNOTES/Sub']) {
      const result = await deleteFolder(vaultPath, folder)

      assert.equal(result.code, 1, folder)
      assert.deepEqual(result.stdout, [], folder)
      assert.match(result.stderr, /Refusing to delete folder ".+": the disk spells it/, folder)
      assert.deepEqual(
        await listFiles(vaultPath),
        ['Sub', 'Sub/child.md', 'real.md'],
        `${folder} deleted files`
      )
    }
  }
)

test('folders delete refuses the vault root', async () => {
  const vaultPath = await makeVault()
  for (const folder of ['/', '.', 'SuperNotes/..']) {
    const result = await deleteFolder(vaultPath, folder)

    assert.equal(result.code, 1, folder)
    assert.deepEqual(
      await listFiles(vaultPath),
      ['Sub', 'Sub/child.md', 'real.md'],
      `${folder} deleted files`
    )
  }
})

test('folders delete removes a folder spelled as on disk and ignores a missing one', async () => {
  const vaultPath = await makeVault()

  const nested = await deleteFolder(vaultPath, 'SuperNotes//Sub')
  assert.equal(nested.code, 0, nested.stderr)
  assert.deepEqual(JSON.parse(nested.stdout.at(-1) ?? '{}'), { success: true })
  assert.deepEqual(await listFiles(vaultPath), ['real.md'])

  const missing = await deleteFolder(vaultPath, 'Elsewhere')
  assert.equal(missing.code, 0, missing.stderr)
  assert.deepEqual(JSON.parse(missing.stdout.at(-1) ?? '{}'), { success: true })

  const top = await deleteFolder(vaultPath, 'SuperNotes/')
  assert.equal(top.code, 0, top.stderr)
  assert.deepEqual(JSON.parse(top.stdout.at(-1) ?? '{}'), { success: true })
  await assert.rejects(fs.access(path.join(vaultPath, 'SuperNotes')), { code: 'ENOENT' })
})
