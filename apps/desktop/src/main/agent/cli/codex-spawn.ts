import { spawn, type ChildProcess } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { createLogger } from '../../lib/logger'

const logger = createLogger('AgentCli:CodexSpawn')

export interface CodexSpawnOptions {
  binaryPath: string
  mcpServerUrl: string
  authorizationValue: string
  conversationId: string
  windowId: string
  prompt: string
}

export interface CodexSubprocess {
  pid: number
  proc: ChildProcess
  cleanup: () => Promise<void>
}

export async function spawnCodexTurn(opts: CodexSpawnOptions): Promise<CodexSubprocess> {
  const dir = await mkdtemp(path.join(tmpdir(), 'memry-codex-'))
  const args = [
    '--ask-for-approval',
    'never',
    '--disable',
    'shell_tool',
    '--disable',
    'apply_patch_freeform',
    'exec',
    '--json',
    '--sandbox',
    'read-only',
    '--ephemeral',
    '--ignore-user-config',
    '--ignore-rules',
    '--skip-git-repo-check',
    '-C',
    dir,
    '-c',
    `mcp_servers.memry.url="${opts.mcpServerUrl}/mcp"`,
    '-c',
    'mcp_servers.memry.bearer_token_env_var="MEMRY_AGENT_TOKEN"',
    '-c',
    'mcp_servers.memry.env_http_headers={"X-Memry-Conversation"="MEMRY_AGENT_CONVERSATION","X-Memry-Window"="MEMRY_AGENT_WINDOW"}',
    '-c',
    'mcp_servers.memry.default_tools_approval_mode="approve"',
    opts.prompt
  ]

  logger.info('Spawning codex with ephemeral MCP config')
  const proc = spawn(opts.binaryPath, args, {
    cwd: dir,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...process.env,
      MEMRY_AGENT_TOKEN: opts.authorizationValue,
      MEMRY_AGENT_CONVERSATION: opts.conversationId,
      MEMRY_AGENT_WINDOW: opts.windowId
    }
  })

  return {
    pid: proc.pid ?? -1,
    proc,
    cleanup: async () => {
      try {
        await rm(dir, { recursive: true, force: true })
      } catch (error) {
        logger.warn('Failed to clean Codex temp directory', error)
      }
    }
  }
}
