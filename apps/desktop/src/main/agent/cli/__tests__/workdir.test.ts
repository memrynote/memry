import type { ChildProcess } from 'node:child_process'
import { mkdir, mkdtemp, readdir, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { spawnAgyTurn } from '../agy-spawn'
import { spawnCodexTurn } from '../codex-spawn'
import { spawnClaudeTurn } from '../spawn'
import { clearAgentMemory, ensureAgentWorkdir } from '../workdir'

const VAULT_A = '35401a5e-46ce-49ce-a18f-88a6f58d2678'
const VAULT_B = '0b7c2f4e-1d2a-4c3b-9e8f-7a6b5c4d3e2f'

let root: string
let workdir: string
let rememberingCli: string

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'memry-agent-workdir-'))
  workdir = path.join(root, 'agent-workdirs', 'vault-a')
  await mkdir(workdir, { recursive: true })
  rememberingCli = path.join(root, 'remembering-cli')
  await writeFile(
    rememberingCli,
    '#!/bin/sh\ncat >/dev/null\necho turn >> memory.txt\nwc -l < memory.txt\n',
    { mode: 0o755 }
  )
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

async function runTurn(sub: { proc: ChildProcess; cleanup: () => Promise<void> }): Promise<string> {
  let stdout = ''
  sub.proc.stdout?.on('data', (chunk: Buffer) => {
    stdout += chunk.toString()
  })
  await new Promise((resolve) => sub.proc.once('close', resolve))
  await sub.cleanup()
  return stdout.trim()
}

describe.skipIf(process.platform === 'win32')('agent working folder', () => {
  it('keeps what a Claude turn wrote for the next Claude turn', async () => {
    const spawnTurn = (): ReturnType<typeof spawnClaudeTurn> =>
      spawnClaudeTurn({ binaryPath: rememberingCli, effort: 'low', prompt: 'hi', cwd: workdir })

    expect(await runTurn(await spawnTurn())).toBe('1')
    expect(await runTurn(await spawnTurn())).toBe('2')
  })

  it('keeps what a Codex turn wrote for the next Codex turn', async () => {
    const spawnTurn = (): ReturnType<typeof spawnCodexTurn> =>
      spawnCodexTurn({
        binaryPath: rememberingCli,
        reasoningEffort: 'low',
        prompt: 'hi',
        cwd: workdir
      })

    expect(await runTurn(await spawnTurn())).toBe('1')
    expect(await runTurn(await spawnTurn())).toBe('2')
  })

  it('keeps what an Antigravity turn wrote for the next Antigravity turn', async () => {
    const spawnTurn = (): ReturnType<typeof spawnAgyTurn> =>
      spawnAgyTurn({
        binaryPath: rememberingCli,
        prompt: 'hi',
        bridge: { command: '/Apps/MemryNote', scriptPath: '/Apps/out/main/agy-mcp-bridge.js' },
        configRoot: path.join(root, 'gemini'),
        cwd: workdir
      })

    expect(await runTurn(await spawnTurn())).toBe('1')
    expect(await runTurn(await spawnTurn())).toBe('2')
  })
})

describe('clearAgentMemory', () => {
  it("deletes one vault's agent folder and its Claude project memory, and nothing else", async () => {
    const userDataDir = path.join(root, 'user-data')
    const claudeConfigDir = path.join(root, 'claude')
    const ownDir = await ensureAgentWorkdir(userDataDir, VAULT_A)
    const otherDir = await ensureAgentWorkdir(userDataDir, VAULT_B)
    expect(ownDir).toBe(path.join(userDataDir, 'agent-workdirs', VAULT_A))
    const claudeProjectDir = async (dir: string): Promise<string> =>
      path.join(claudeConfigDir, 'projects', (await realpath(dir)).replace(/[^a-zA-Z0-9]/g, '-'))
    for (const dir of [ownDir, otherDir]) {
      await writeFile(path.join(dir, 'CLAUDE.md'), 'remembered')
      const memoryDir = path.join(await claudeProjectDir(dir), 'memory')
      await mkdir(memoryDir, { recursive: true })
      await writeFile(path.join(memoryDir, 'MEMORY.md'), 'remembered')
    }

    await clearAgentMemory({ userDataDir, vaultId: VAULT_A, claudeConfigDir })

    expect(await readdir(path.join(userDataDir, 'agent-workdirs'))).toEqual([VAULT_B])
    expect(await readdir(path.join(claudeConfigDir, 'projects'))).toEqual([
      path.basename(await claudeProjectDir(otherDir))
    ])
  })

  it('leaves Claude project folders alone when the agent folder path is past the CLI key limit', async () => {
    const userDataDir = path.join(root, 'a'.repeat(120), 'b'.repeat(120))
    const claudeConfigDir = path.join(root, 'claude')
    const dir = await ensureAgentWorkdir(userDataDir, 'vault-a')
    const hashedKey = `${(await realpath(dir)).replace(/[^a-zA-Z0-9]/g, '-').slice(0, 200)}-1x2y3z`
    await mkdir(path.join(claudeConfigDir, 'projects', hashedKey), { recursive: true })

    await clearAgentMemory({ userDataDir, vaultId: 'vault-a', claudeConfigDir })

    expect(await readdir(path.join(userDataDir, 'agent-workdirs'))).toEqual([])
    expect(await readdir(path.join(claudeConfigDir, 'projects'))).toEqual([hashedKey])
  })

  it.each(['..', '../..', 'a/b', '/etc', '.'])(
    'keeps a vault id of %j inside agent-workdirs and deletes nothing outside it',
    async (vaultId) => {
      const userDataDir = path.join(root, 'user-data')
      const claudeConfigDir = path.join(root, 'claude')
      await mkdir(userDataDir, { recursive: true })
      await writeFile(path.join(userDataDir, 'memry-data.db'), 'notes')

      const dir = await ensureAgentWorkdir(userDataDir, vaultId)
      await clearAgentMemory({ userDataDir, vaultId, claudeConfigDir })

      expect(path.dirname(dir)).toBe(path.join(userDataDir, 'agent-workdirs'))
      expect((await readdir(userDataDir)).sort()).toEqual(['agent-workdirs', 'memry-data.db'])
    }
  )

  it('maps two casings of one vault uuid to one folder', async () => {
    const userDataDir = path.join(root, 'user-data')

    expect(await ensureAgentWorkdir(userDataDir, '35401A5E-46CE-49CE-A18F-88A6F58D2678')).toBe(
      path.join(userDataDir, 'agent-workdirs', '35401a5e-46ce-49ce-a18f-88a6f58d2678')
    )
    expect(await ensureAgentWorkdir(userDataDir, '35401a5e-46ce-49ce-a18f-88a6f58d2678')).toBe(
      path.join(userDataDir, 'agent-workdirs', '35401a5e-46ce-49ce-a18f-88a6f58d2678')
    )
  })

  it('succeeds when the vault has no agent memory yet', async () => {
    await expect(
      clearAgentMemory({
        userDataDir: path.join(root, 'user-data'),
        vaultId: 'vault-a',
        claudeConfigDir: path.join(root, 'claude')
      })
    ).resolves.toBeUndefined()
  })
})
