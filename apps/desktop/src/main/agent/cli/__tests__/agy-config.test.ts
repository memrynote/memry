import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../../../lib/logger', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() })
}))

import {
  AGY_COMPUTER_PROJECT_ID,
  AGY_MCP_SERVER_NAME,
  AGY_VAULT_PROJECT_ID,
  ensureAgyConfig
} from '../agy-config'

const BRIDGE = {
  bridgeCommand: '/Applications/MemryNote.app/Contents/MacOS/MemryNote',
  bridgeScriptPath: '/Applications/MemryNote.app/out/main/agy-mcp-bridge.js'
}

let configRoot: string

beforeEach(async () => {
  configRoot = await mkdtemp(path.join(tmpdir(), 'memry-agy-config-'))
})

async function readJson(file: string): Promise<Record<string, unknown>> {
  return JSON.parse(await readFile(file, 'utf8'))
}

function mcpConfigPath(): string {
  return path.join(configRoot, 'config', 'mcp_config.json')
}

function projectPath(id: string): string {
  return path.join(configRoot, 'config', 'projects', `${id}.json`)
}

describe('ensureAgyConfig', () => {
  it('registers the bridge without secrets and selects the vault-only project', async () => {
    const result = await ensureAgyConfig({
      ...BRIDGE,
      permissions: { accessMode: 'vault_only', webSearchEnabled: false },
      configRoot
    })

    expect(result).toEqual({
      projectId: AGY_VAULT_PROJECT_ID,
      serverName: AGY_MCP_SERVER_NAME
    })

    const raw = await readFile(mcpConfigPath(), 'utf8')
    // The per-turn token and write grant travel in the spawned process's
    // environment precisely because agy does not expand env references in this
    // file. Anything token-shaped here would be a plaintext secret on disk.
    expect(raw).not.toMatch(/MEMRY_AGENT_TOKEN|MEMRY_AGENT_TURN|Bearer/)

    const config = await readJson(mcpConfigPath())
    expect(config.mcpServers).toMatchObject({
      memry: {
        command: BRIDGE.bridgeCommand,
        args: [BRIDGE.bridgeScriptPath],
        env: { ELECTRON_RUN_AS_NODE: '1' }
      }
    })

    const project = await readJson(projectPath(AGY_VAULT_PROJECT_ID))
    expect(project).toMatchObject({
      id: AGY_VAULT_PROJECT_ID,
      permissionGrants: {
        permissionGrants: { allow: ['mcp(memry/*)'], deny: ['command(*)'] }
      },
      settings: { fileAccessPolicy: 'AGENT_SETTING_POLICY_DENY', sandboxMode: true }
    })
  })

  it('keeps every other MCP server the user configured', async () => {
    await mkdir(path.join(configRoot, 'config'), { recursive: true })
    await writeFile(
      mcpConfigPath(),
      JSON.stringify({
        mcpServers: {
          linter: { command: 'npx', args: ['-y', 'linter-mcp'], enabledTools: ['lint'] }
        }
      }),
      'utf8'
    )

    await ensureAgyConfig({
      ...BRIDGE,
      permissions: { accessMode: 'vault_only', webSearchEnabled: false },
      configRoot
    })

    const servers = (await readJson(mcpConfigPath())).mcpServers as Record<string, unknown>
    expect(servers.linter).toEqual({
      command: 'npx',
      args: ['-y', 'linter-mcp'],
      enabledTools: ['lint']
    })
    expect(servers.memry).toBeDefined()
  })

  it('preserves fields a newer client wrote on our own entry', async () => {
    await mkdir(path.join(configRoot, 'config'), { recursive: true })
    await writeFile(
      mcpConfigPath(),
      JSON.stringify({
        mcpServers: {
          [AGY_MCP_SERVER_NAME]: {
            command: 'old',
            args: ['old.js'],
            env: {},
            memryManaged: true,
            timeoutSeconds: 120
          }
        }
      }),
      'utf8'
    )

    await ensureAgyConfig({
      ...BRIDGE,
      permissions: { accessMode: 'vault_only', webSearchEnabled: false },
      configRoot
    })

    const servers = (await readJson(mcpConfigPath())).mcpServers as Record<
      string,
      Record<string, unknown>
    >
    expect(servers[AGY_MCP_SERVER_NAME].timeoutSeconds).toBe(120)
    expect(servers[AGY_MCP_SERVER_NAME].command).toBe(BRIDGE.bridgeCommand)
  })

  it('reads a config that uses comments and trailing commas', async () => {
    await mkdir(path.join(configRoot, 'config'), { recursive: true })
    await writeFile(
      mcpConfigPath(),
      `{
  // agy tolerates comments here, so a strict parse would reject a valid file
  "mcpServers": {
    "linter": { "command": "npx", "args": ["linter"] },
  }
}`,
      'utf8'
    )

    await ensureAgyConfig({
      ...BRIDGE,
      permissions: { accessMode: 'vault_only', webSearchEnabled: false },
      configRoot
    })

    const servers = (await readJson(mcpConfigPath())).mcpServers as Record<string, unknown>
    expect(servers.linter).toBeDefined()
    expect(servers.memry).toBeDefined()
  })

  it('refuses to clobber a config it cannot parse', async () => {
    await mkdir(path.join(configRoot, 'config'), { recursive: true })
    await writeFile(mcpConfigPath(), '{ "mcpServers": { "linter": ', 'utf8')

    await expect(
      ensureAgyConfig({
        ...BRIDGE,
        permissions: { accessMode: 'vault_only', webSearchEnabled: false },
        configRoot
      })
    ).rejects.toThrow(/could not be read/)

    // Still the user's bytes, not ours.
    expect(await readFile(mcpConfigPath(), 'utf8')).toBe('{ "mcpServers": { "linter": ')
  })

  it('leaves the file untouched on a second identical call', async () => {
    const input = {
      ...BRIDGE,
      permissions: { accessMode: 'vault_only' as const, webSearchEnabled: false },
      configRoot
    }
    await ensureAgyConfig(input)
    const first = await readFile(mcpConfigPath(), 'utf8')
    await ensureAgyConfig(input)

    expect(await readFile(mcpConfigPath(), 'utf8')).toBe(first)
  })

  it('selects a separate project for computer access, with no shell deny rule', async () => {
    const result = await ensureAgyConfig({
      ...BRIDGE,
      permissions: { accessMode: 'computer_access', webSearchEnabled: false },
      configRoot
    })

    expect(result.projectId).toBe(AGY_COMPUTER_PROJECT_ID)
    const project = (await readJson(projectPath(AGY_COMPUTER_PROJECT_ID))) as {
      permissionGrants: { permissionGrants: { allow: string[]; deny?: string[] } }
      settings: { sandboxMode: boolean }
    }
    expect(project.permissionGrants.permissionGrants.deny).toBeUndefined()
    expect(project.settings.sandboxMode).toBe(false)
  })

  it('grants URL reads only when web search is enabled', async () => {
    await ensureAgyConfig({
      ...BRIDGE,
      permissions: { accessMode: 'vault_only', webSearchEnabled: true },
      configRoot
    })

    const project = (await readJson(projectPath(AGY_VAULT_PROJECT_ID))) as {
      permissionGrants: { permissionGrants: { allow: string[] } }
    }
    expect(project.permissionGrants.permissionGrants.allow).toEqual(['mcp(memry/*)', 'read_url(*)'])
  })
})
