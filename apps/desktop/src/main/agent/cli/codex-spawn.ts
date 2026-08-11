import { spawn, type ChildProcess } from 'node:child_process'
import { once } from 'node:events'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

import type { AgentTurnPermissions, CodexReasoningEffort } from '@memry/contracts/ipc-agent'

import { createLogger } from '../../lib/logger'

const logger = createLogger('AgentCli:CodexSpawn')
const DEFAULT_TURN_PERMISSIONS: AgentTurnPermissions = {
  accessMode: 'vault_only',
  webSearchEnabled: false
}

export interface CodexSpawnOptions {
  binaryPath: string
  prompt: string
  reasoningEffort: CodexReasoningEffort
  model?: string
  permissions?: AgentTurnPermissions
  mcp?: {
    serverUrl: string
    authorizationValue: string
    conversationId: string
    windowId: string
  }
}

export interface CodexSubprocess {
  pid: number
  proc: ChildProcess
  cleanup: () => Promise<void>
}

export async function spawnCodexTurn(opts: CodexSpawnOptions): Promise<CodexSubprocess> {
  const dir = await mkdtemp(path.join(tmpdir(), 'memry-codex-'))
  const permissions = opts.permissions ?? DEFAULT_TURN_PERMISSIONS
  const args = ['--ask-for-approval', 'never']
  if (permissions.webSearchEnabled) {
    args.push('--search')
  }
  if (permissions.accessMode === 'vault_only') {
    args.push('--disable', 'shell_tool', '--disable', 'apply_patch_freeform')
  }
  args.push(
    'exec',
    '--json',
    '--sandbox',
    permissions.accessMode === 'computer_access' ? 'danger-full-access' : 'read-only',
    '--ephemeral',
    '--ignore-user-config',
    '--ignore-rules',
    '--skip-git-repo-check',
    '-C',
    dir,
    '-c',
    `model_reasoning_effort="${opts.reasoningEffort}"`
  )
  if (opts.model) {
    args.push('--model', opts.model)
  }

  if (opts.mcp) {
    args.push(
      '-c',
      `mcp_servers.memry.url="${opts.mcp.serverUrl}/mcp"`,
      '-c',
      'mcp_servers.memry.bearer_token_env_var="MEMRY_AGENT_TOKEN"',
      '-c',
      'mcp_servers.memry.env_http_headers={"X-Memry-Conversation"="MEMRY_AGENT_CONVERSATION","X-Memry-Window"="MEMRY_AGENT_WINDOW"}',
      '-c',
      'mcp_servers.memry.default_tools_approval_mode="approve"'
    )
  }
  args.push(opts.prompt)

  logger.info('Spawning codex with ephemeral MCP config')
  const proc = spawn(opts.binaryPath, args, {
    cwd: dir,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...process.env,
      ...(opts.mcp
        ? {
            MEMRY_AGENT_TOKEN: opts.mcp.authorizationValue,
            MEMRY_AGENT_CONVERSATION: opts.mcp.conversationId,
            MEMRY_AGENT_WINDOW: opts.mcp.windowId
          }
        : {})
    }
  })
  // A child that never starts (binary removed after the version probe, EACCES,
  // EAGAIN) emits 'error' and never 'exit'. Unhandled, that is a main-process
  // uncaughtException; and because the caller's exit promise only ever listens
  // for 'exit', the turn would hang forever and hold its conversation's turn
  // lock for the rest of the app run. 'spawn' and 'error' are mutually
  // exclusive and exactly one always fires, so this wait is bounded.
  proc.on('error', (error) => {
    logger.error('Codex subprocess error', error)
  })
  try {
    await once(proc, 'spawn')
  } catch (error) {
    // No handle reaches the caller, so nothing else would clean the temp dir up.
    await rm(dir, { recursive: true, force: true }).catch((cleanupError: unknown) => {
      logger.warn('Failed to clean Codex temp directory', cleanupError)
    })
    throw new Error(
      `Codex CLI failed to start: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error }
    )
  }

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
