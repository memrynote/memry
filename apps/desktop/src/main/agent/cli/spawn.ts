import { spawn, type ChildProcess } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { createLogger } from '../../lib/logger'

const logger = createLogger('AgentCli:Spawn')

export interface SpawnOptions {
  binaryPath: string
  mcpServerUrl: string
  authorizationValue: string
  conversationId: string
  windowId: string
  allowedTools: string
  prompt: string
}

export interface ClaudeSubprocess {
  pid: number
  proc: ChildProcess
  cleanup: () => Promise<void>
}

export async function spawnClaudeTurn(opts: SpawnOptions): Promise<ClaudeSubprocess> {
  const dir = await mkdtemp(path.join(tmpdir(), 'memry-claude-'))
  const configPath = path.join(dir, 'mcp-config.json')
  const config = {
    mcpServers: {
      memry: {
        type: 'http',
        url: `${opts.mcpServerUrl}/mcp`,
        headers: {
          Authorization: `Bearer ${opts.authorizationValue}`,
          'X-Memry-Conversation': opts.conversationId,
          'X-Memry-Window': opts.windowId
        }
      }
    }
  }

  await writeFile(configPath, JSON.stringify(config))

  const args = [
    '-p',
    '--input-format',
    'text',
    '--output-format',
    'stream-json',
    '--include-partial-messages',
    '--mcp-config',
    configPath,
    '--strict-mcp-config',
    '--no-session-persistence',
    '--tools',
    '',
    '--allowed-tools',
    opts.allowedTools
  ]

  logger.info(`Spawning claude with strict MCP config`)
  const proc = spawn(opts.binaryPath, args, {
    cwd: dir,
    env: { ...process.env }
  })
  proc.stdin?.write(opts.prompt)
  proc.stdin?.end()

  return {
    pid: proc.pid ?? -1,
    proc,
    cleanup: async () => {
      try {
        await rm(dir, { recursive: true, force: true })
      } catch (error) {
        logger.warn('Failed to clean Claude temp directory', error)
      }
    }
  }
}
