import { mkdir, realpath, rm } from 'node:fs/promises'
import { homedir } from 'node:os'
import path from 'node:path'

import { createLogger } from '../../lib/logger'
import { vaultDirName } from '../../lib/vault-dir-name'

const logger = createLogger('AgentCli:Workdir')

/**
 * Windows keeps a folder busy for a moment after the process inside it exits,
 * so a single rm fails with EBUSY. Node retries EBUSY, EPERM and ENOTEMPTY
 * itself when maxRetries is set.
 */
export const REMOVE_DIR_OPTIONS = {
  recursive: true,
  force: true,
  maxRetries: 5,
  retryDelay: 200
} as const

/** Claude Code hashes project keys past this length, and the hash is internal to the CLI. */
const CLAUDE_PROJECT_KEY_MAX_LENGTH = 200

/**
 * The folder every agent CLI runs in for one vault. Claude Code keys its
 * project memory by the working folder, so a folder that outlives the turn is
 * what lets memory carry over. It sits outside the vault so the agent's notes
 * to itself never sync or show up as vault files.
 */
export function agentWorkdirPath(userDataDir: string, vaultId: string): string {
  const root = path.join(userDataDir, 'agent-workdirs')
  const dir = path.join(root, vaultDirName(vaultId))
  // Clear deletes this folder recursively, so it must never resolve outside its root.
  if (path.dirname(dir) !== root) throw new Error('Agent folder resolves outside agent-workdirs')
  return dir
}

export async function ensureAgentWorkdir(userDataDir: string, vaultId: string): Promise<string> {
  const dir = agentWorkdirPath(userDataDir, vaultId)
  await mkdir(dir, { recursive: true })
  return dir
}

export interface ClearAgentMemoryInput {
  userDataDir: string
  vaultId: string
  claudeConfigDir?: string
}

export async function clearAgentMemory(input: ClearAgentMemoryInput): Promise<void> {
  const dir = agentWorkdirPath(input.userDataDir, input.vaultId)
  // Claude Code names the project after the physical path it runs in.
  const physicalDir = await realpath(dir).catch(() => dir)
  const projectKey = physicalDir.replace(/[^a-zA-Z0-9]/g, '-')
  if (projectKey.length <= CLAUDE_PROJECT_KEY_MAX_LENGTH) {
    const claudeConfigDir =
      input.claudeConfigDir ?? process.env.CLAUDE_CONFIG_DIR ?? path.join(homedir(), '.claude')
    await rm(path.join(claudeConfigDir, 'projects', projectKey), REMOVE_DIR_OPTIONS)
  } else {
    logger.warn('Agent folder path is too long to locate its Claude Code project memory')
  }
  await rm(dir, REMOVE_DIR_OPTIONS)
}
