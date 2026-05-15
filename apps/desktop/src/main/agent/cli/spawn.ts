import { spawn, type ChildProcess } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

import type { ClaudeEffort } from '@memry/contracts/ipc-agent'

import { createLogger } from '../../lib/logger'

const logger = createLogger('AgentCli:Spawn')

export interface SpawnOptions {
  binaryPath: string
  mcp?: {
    serverUrl: string
    authorizationValue: string
    conversationId: string
    windowId: string
    allowedTools: string
  }
  effort: ClaudeEffort
  model?: string
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

  const args = [
    '-p',
    '--input-format',
    'text',
    '--output-format',
    'stream-json',
    '--include-partial-messages',
    '--verbose',
    '--no-session-persistence',
    '--tools',
    '',
    '--effort',
    opts.effort
  ]
  if (opts.mcp) {
    const config = {
      mcpServers: {
        memry: {
          type: 'http',
          url: `${opts.mcp.serverUrl}/mcp`,
          headers: {
            Authorization: `Bearer ${opts.mcp.authorizationValue}`,
            'X-Memry-Conversation': opts.mcp.conversationId,
            'X-Memry-Window': opts.mcp.windowId
          }
        }
      }
    }

    await writeFile(configPath, JSON.stringify(config))
    args.splice(7, 0, '--mcp-config', configPath, '--strict-mcp-config')
    args.splice(args.indexOf('--effort'), 0, '--allowed-tools', opts.mcp.allowedTools)
  }
  if (opts.model) {
    args.push('--model', opts.model)
  }

  logger.info(
    opts.mcp ? 'Spawning claude with strict MCP config' : 'Spawning claude without MCP config'
  )
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
