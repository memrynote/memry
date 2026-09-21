import { spawn, type ChildProcess } from 'node:child_process'
import { once } from 'node:events'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

import type { AgentTurnPermissions } from '@memry/contracts/ipc-agent'

import { createLogger } from '../../lib/logger'
import { ensureAgyConfig } from './agy-config'

const logger = createLogger('AgentCli:AgySpawn')
const DEFAULT_TURN_PERMISSIONS: AgentTurnPermissions = {
  accessMode: 'vault_only',
  webSearchEnabled: false
}

export interface AgySpawnOptions {
  binaryPath: string
  prompt: string
  model?: string
  permissions?: AgentTurnPermissions
  /** Electron's own binary plus the built bridge script it runs as node. */
  bridge: { command: string; scriptPath: string }
  mcp?: {
    serverUrl: string
    authorizationValue: string
    writeGrant: string
    windowId: string
  }
  /** Override for tests; defaults to `~/.gemini`. */
  configRoot?: string
}

export interface AgySubprocess {
  pid: number
  proc: ChildProcess
  cleanup: () => Promise<void>
}

/**
 * Runtime for the stdio MCP bridge: Electron's own binary, run as node.
 *
 * The bridge is a separate rollup entry, so it sits next to the main bundle in
 * both dev and packaged builds — the same arrangement the sync and embedding
 * workers use.
 */
export function agyBridgeRuntime(): { command: string; scriptPath: string } {
  return {
    command: process.execPath,
    scriptPath: path.join(__dirname, 'agy-mcp-bridge.js')
  }
}

export async function spawnAgyTurn(opts: AgySpawnOptions): Promise<AgySubprocess> {
  const permissions = opts.permissions ?? DEFAULT_TURN_PERMISSIONS
  const { projectId } = await ensureAgyConfig({
    bridgeCommand: opts.bridge.command,
    bridgeScriptPath: opts.bridge.scriptPath,
    permissions,
    ...(opts.configRoot ? { configRoot: opts.configRoot } : {})
  })

  const dir = await mkdtemp(path.join(tmpdir(), 'memry-agy-'))
  const args = [
    // Prompt over stdin, not argv: a turn carries whole notes, and an argv
    // large enough to hold one is past the platform limit.
    '--input-format',
    'stream-json',
    '--output-format',
    'stream-json',
    // Attached note content routinely starts a line with "/". Without this a
    // leading slash is read as a slash command, which ends a stream-json
    // session with an error instead of answering.
    '--disable-slash-commands',
    '--project',
    projectId
  ]
  if (permissions.accessMode === 'computer_access') {
    args.push('--dangerously-skip-permissions', '--add-dir', '/')
  }
  if (opts.model) {
    args.push('--model', opts.model)
  }

  logger.info(`Spawning agy with project ${projectId}`)
  const proc = spawn(opts.binaryPath, args, {
    cwd: dir,
    stdio: ['pipe', 'pipe', 'pipe'],
    env: {
      ...process.env,
      // Inherited by the stdio MCP child agy launches, which is how the bridge
      // learns where to reach Memry and which turn it speaks for. agy itself
      // ignores ELECTRON_RUN_AS_NODE; the bridge needs it.
      ELECTRON_RUN_AS_NODE: '1',
      ...(opts.mcp
        ? {
            MEMRY_MCP_URL: `${opts.mcp.serverUrl}/mcp`,
            MEMRY_AGENT_TOKEN: opts.mcp.authorizationValue,
            MEMRY_AGENT_TURN: opts.mcp.writeGrant,
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
    logger.error('Antigravity subprocess error', error)
  })
  try {
    await once(proc, 'spawn')
  } catch (error) {
    // No handle reaches the caller, so nothing else would clean the temp dir up.
    await rm(dir, { recursive: true, force: true }).catch((cleanupError: unknown) => {
      logger.warn('Failed to clean Antigravity temp directory', cleanupError)
    })
    throw new Error(
      `Antigravity CLI failed to start: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error }
    )
  }
  // EPIPE from a CLI that exits before it has read the whole prompt is emitted
  // on stdin, not on the child.
  proc.stdin?.on('error', (error) => {
    logger.warn('Antigravity subprocess stdin error', error)
  })
  proc.stdin?.write(`${JSON.stringify({ event: 'user', message: { content: opts.prompt } })}\n`)
  // Closing stdin is what ends the session: agy exits once the input pipe is
  // closed and the turn it is already running completes.
  proc.stdin?.end()

  return {
    pid: proc.pid ?? -1,
    proc,
    cleanup: async () => {
      try {
        await rm(dir, { recursive: true, force: true })
      } catch (error) {
        logger.warn('Failed to clean Antigravity temp directory', error)
      }
    }
  }
}
