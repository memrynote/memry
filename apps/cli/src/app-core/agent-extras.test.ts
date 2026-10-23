import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import fs from 'node:fs/promises'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import path from 'node:path'
import test from 'node:test'

import { agentConversations, agentMessages } from '@memry/db-schema/data-schema'

import { runCli } from '../run.ts'
import { openDatabases } from './database.ts'

async function makeVault() {
  const root = path.join(process.cwd(), 'test-results', 'memry-cli-agent-extras')
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

function seedConversation(vaultPath: string): void {
  const databases = openDatabases(vaultPath)
  try {
    databases.dataDb
      .insert(agentConversations)
      .values([
        {
          id: 'conv_old',
          vaultId: 'vault_1',
          titleCiphertext: '{"ciphertext":"secret"}',
          backend: 'claude_cli',
          backendModel: 'sonnet',
          vectorClock: {},
          fieldClocks: {},
          createdAt: 1_000,
          updatedAt: 2_000
        },
        {
          id: 'conv_new',
          vaultId: 'vault_1',
          titleCiphertext: '{"ciphertext":"secret"}',
          backend: 'local_openai_compatible',
          pinned: true,
          vectorClock: {},
          fieldClocks: {},
          createdAt: 3_000,
          updatedAt: 4_000
        },
        {
          id: 'conv_deleted',
          vaultId: 'vault_1',
          titleCiphertext: '{"ciphertext":"secret"}',
          backend: 'claude_cli',
          vectorClock: {},
          fieldClocks: {},
          createdAt: 1,
          updatedAt: 9_000,
          deletedAt: 9_000
        }
      ])
      .run()
    const message = (id: string, deletedAt: number | null) => ({
      id,
      conversationId: 'conv_old',
      role: 'user',
      contentCiphertext: '{"ciphertext":"secret"}',
      attachmentsCiphertext: '[]',
      status: 'complete',
      vectorClock: {},
      createdAt: 1,
      updatedAt: 1,
      deletedAt
    })
    databases.dataDb
      .insert(agentMessages)
      .values([message('m1', null), message('m2', null), message('m3', 5)])
      .run()
  } finally {
    databases.close()
  }
}

async function serveModels(models: string[] | 'error'): Promise<{
  baseUrl: string
  close(): Promise<void>
}> {
  const server = http.createServer((request, response) => {
    if (request.url === '/v1/models' && models !== 'error') {
      response.setHeader('content-type', 'application/json')
      response.end(JSON.stringify({ data: models.map((id) => ({ id })) }))
      return
    }
    response.statusCode = 500
    response.end('boom')
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address() as AddressInfo
  return {
    baseUrl: `http://127.0.0.1:${port}/v1`,
    close: () => new Promise<void>((resolve) => server.close(() => resolve()))
  }
}

test('agent conversations lists readable metadata, newest first, without the encrypted title', async () => {
  const vault = await makeVault()
  assert.deepEqual(await runOk(vault, ['agent', 'conversations']), [])
  seedConversation(vault)

  const list = await runOk<Array<Record<string, unknown>>>(vault, ['agent', 'conversations'])
  assert.deepEqual(
    list.map((conversation) => conversation.id),
    ['conv_new', 'conv_old']
  )
  assert.equal(list[1]?.messageCount, 2)
  assert.equal(list[1]?.backendModel, 'sonnet')
  assert.equal(list[0]?.pinned, true)
  assert.ok(!JSON.stringify(list).includes('secret'))

  const one = await runOk<{ id: string; messageCount: number }>(vault, [
    'agent',
    'conversation',
    'conv_old'
  ])
  assert.equal(one.messageCount, 2)
  const deleted = await run(vault, ['agent', 'conversation', 'conv_deleted'])
  assert.equal(deleted.code, 1)
  assert.match(deleted.stderr, /not found/)
  const missingId = await run(vault, ['agent', 'conversation'])
  assert.equal(missingId.code, 1)
})

test('agent preferences, mcp status and token rotation explain the desktop owns them', async () => {
  const vault = await makeVault()
  for (const args of [
    ['agent', 'preferences'],
    ['agent', 'set-preferences', '--access-mode', 'vault_only'],
    ['agent', 'mcp-status'],
    ['agent', 'mcp', 'status'],
    ['agent', 'mcp', 'rotate-token', '--yes']
  ]) {
    const result = await run(vault, args)
    assert.equal(result.code, 1, args.join(' '))
    assert.match(result.stderr, /needs the Memry desktop app/)
  }
  const noYes = await run(vault, ['agent', 'mcp', 'rotate-token'])
  assert.equal(noYes.code, 1)
  assert.match(noYes.stderr, /--yes/)
  const unknown = await run(vault, ['agent', 'mcp', 'bogus'])
  assert.equal(unknown.code, 1)
  assert.match(unknown.stderr, /Usage/)
})

test('agent local-models and test-local talk to the configured provider', async () => {
  const vault = await makeVault()
  const provider = await serveModels(['llama3', 'qwen'])
  try {
    await runOk(vault, [
      'agent',
      'set-local-settings',
      '--base-url',
      provider.baseUrl,
      '--model',
      'llama3'
    ])
    assert.deepEqual(await runOk(vault, ['agent', 'local-models']), { models: ['llama3', 'qwen'] })
    const ok = await runOk<{ connected: boolean; modelAvailable: boolean; detail: string | null }>(
      vault,
      ['agent', 'test-local']
    )
    assert.equal(ok.connected, true)
    assert.equal(ok.modelAvailable, true)
    assert.equal(ok.detail, null)

    await runOk(vault, ['agent', 'set-local-settings', '--model', 'missing'])
    const absent = await runOk<{ connected: boolean; modelAvailable: boolean; detail: string }>(
      vault,
      ['agent', 'test-local']
    )
    assert.equal(absent.connected, true)
    assert.equal(absent.modelAvailable, false)
    assert.match(absent.detail, /missing was not returned/)
  } finally {
    await provider.close()
  }

  const down = await runOk<{ connected: boolean; detail: string }>(vault, ['agent', 'test-local'])
  assert.equal(down.connected, false)
  assert.ok(down.detail.length > 0)
  assert.deepEqual(await runOk(vault, ['agent', 'local-models']), { models: [] })
})

test('agent local-models refuses a non-loopback endpoint without the explicit opt-in', async () => {
  const vault = await makeVault()
  await runOk(vault, [
    'agent',
    'set-local-settings',
    '--base-url',
    'https://models.example.com/v1',
    '--allow-non-loopback',
    'true'
  ])
  const stored = await runOk<{ allowNonLoopback: boolean }>(vault, ['agent', 'local-settings'])
  assert.equal(stored.allowNonLoopback, true)
  // Reaching in from outside the CLI: drop the opt-in the way a hand-edited settings row would.
  const databases = openDatabases(vault)
  try {
    const { settings } = await import('@memry/db-schema/data-schema')
    databases.dataDb
      .update(settings)
      .set({
        value: JSON.stringify({
          localProvider: {
            preset: 'custom',
            baseUrl: 'https://models.example.com/v1',
            model: '',
            allowNonLoopback: false
          }
        })
      })
      .run()
  } finally {
    databases.close()
  }
  for (const sub of ['local-models', 'test-local']) {
    const result = await run(vault, ['agent', sub])
    assert.equal(result.code, 1, sub)
    assert.match(result.stderr, /Non-loopback/)
  }
})
