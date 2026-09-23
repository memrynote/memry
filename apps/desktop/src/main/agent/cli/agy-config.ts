import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import path from 'node:path'

import type { AgentTurnPermissions } from '@memry/contracts/ipc-agent'

import { createLogger } from '../../lib/logger'
import { markExpectedCondition } from '../../telemetry/expected-conditions'

const logger = createLogger('AgentCli:AgyConfig')

/**
 * Antigravity CLI offers no per-run MCP config and no per-run permission flag:
 * `~/.gemini/config/mcp_config.json` is read at process start, and tool
 * permissions come from user-level settings or from a project file selected
 * with `--project`. Two consequences shape this module:
 *
 * - The MCP entry must be static, because header values in mcp_config.json are
 *   NOT environment-expanded (a `${VAR}` header arrives at the server
 *   literally). The per-turn write grant therefore travels in the environment
 *   of the spawned `agy` process, which its stdio MCP child inherits, and the
 *   entry points at a Memry-shipped stdio bridge instead of at the HTTP
 *   endpoint directly.
 * - Permissions must be pre-granted, because in headless mode a tool that
 *   would prompt is auto-denied: without `mcp(memry/*)` under an allow rule the
 *   run exits 0 with an empty answer and only a stderr notice.
 */
export const AGY_MCP_SERVER_NAME = 'memry'
export const AGY_VAULT_PROJECT_ID = 'memry-agent-vault'
export const AGY_COMPUTER_PROJECT_ID = 'memry-agent-computer'

/** Marks the entry as app-managed, so an overwrite can be logged honestly. */
const MANAGED_MARKER = 'memryManaged'

interface McpServerEntry {
  command: string
  args: string[]
  env: Record<string, string>
  [MANAGED_MARKER]?: boolean
}

export interface AgyConfigInput {
  /** Runtime that executes the bridge — Electron's own binary, run as node. */
  bridgeCommand: string
  bridgeScriptPath: string
  permissions: AgentTurnPermissions
  /** Override for tests; defaults to `~/.gemini`. */
  configRoot?: string
}

export interface AgyConfigResult {
  projectId: string
  serverName: string
}

export function agyConfigRoot(): string {
  return path.join(homedir(), '.gemini')
}

/**
 * Bring the user's Antigravity config in line with what this turn needs and
 * return the project to select.
 *
 * Idempotent and merge-preserving: the MCP file keeps every other server and
 * every field of ours it does not know about, and nothing is rewritten when the
 * desired content already matches. Comments in `mcp_config.json` (which agy
 * tolerates) do not survive an update — same as `agy mcp add`.
 */
export async function ensureAgyConfig(input: AgyConfigInput): Promise<AgyConfigResult> {
  const root = input.configRoot ?? agyConfigRoot()
  const configDir = path.join(root, 'config')
  const projectsDir = path.join(configDir, 'projects')
  await mkdir(projectsDir, { recursive: true })

  await ensureMcpServerEntry(path.join(configDir, 'mcp_config.json'), {
    command: input.bridgeCommand,
    args: [input.bridgeScriptPath],
    // Set here as well as on the `agy` spawn: a user's own `agy` session reads
    // this file too, and without it the bridge would launch Electron as a
    // second Memry window instead of as a node script.
    env: { ELECTRON_RUN_AS_NODE: '1' },
    [MANAGED_MARKER]: true
  })

  const computerAccess = input.permissions.accessMode === 'computer_access'
  const projectId = computerAccess ? AGY_COMPUTER_PROJECT_ID : AGY_VAULT_PROJECT_ID
  await writeIfChanged(
    path.join(projectsDir, `${projectId}.json`),
    `${JSON.stringify(projectFile(projectId, input.permissions), null, 2)}\n`
  )

  return { projectId, serverName: AGY_MCP_SERVER_NAME }
}

function projectFile(projectId: string, permissions: AgentTurnPermissions): unknown {
  const computerAccess = permissions.accessMode === 'computer_access'
  const allow = [`mcp(${AGY_MCP_SERVER_NAME}/*)`]
  // Best effort: `read_url` is the documented rule for fetching a URL. A
  // built-in web search that is gated under some other action name simply stays
  // denied, which degrades the toggle instead of breaking the turn.
  if (permissions.webSearchEnabled || computerAccess) allow.push('read_url(*)')

  return {
    id: projectId,
    name: computerAccess ? 'Memry Agent (computer access)' : 'Memry Agent (vault only)',
    projectResources: {},
    permissionGrants: {
      permissionGrants: {
        allow,
        // Vault-only turns get no shell. Computer-access turns are spawned with
        // --dangerously-skip-permissions, so a deny list there would only be
        // misleading.
        ...(computerAccess ? {} : { deny: ['command(*)'] })
      }
    },
    settings: {
      fileAccessPolicy: computerAccess ? 'AGENT_SETTING_POLICY_ALLOW' : 'AGENT_SETTING_POLICY_DENY',
      sandboxMode: !computerAccess
    },
    isWorkspaceOnly: false
  }
}

async function ensureMcpServerEntry(file: string, entry: McpServerEntry): Promise<void> {
  const existing = await readMcpConfig(file)
  const root = isRecord(existing) ? { ...existing } : {}
  const servers = isRecord(root.mcpServers) ? { ...root.mcpServers } : {}
  const current = servers[AGY_MCP_SERVER_NAME]

  if (isRecord(current) && sameEntry(current, entry)) return
  if (isRecord(current) && current[MANAGED_MARKER] !== true) {
    logger.warn(
      `Replacing an existing "${AGY_MCP_SERVER_NAME}" MCP server in ${file} with the app-managed bridge`
    )
  }

  // Preserve anything agy (or a newer Memry) wrote on our entry that this
  // version does not know about.
  servers[AGY_MCP_SERVER_NAME] = isRecord(current) ? { ...current, ...entry } : entry
  root.mcpServers = servers
  await writeIfChanged(file, `${JSON.stringify(root, null, 2)}\n`)
}

function sameEntry(current: Record<string, unknown>, entry: McpServerEntry): boolean {
  const args = current.args
  const env = isRecord(current.env) ? current.env : {}
  return (
    current.command === entry.command &&
    Array.isArray(args) &&
    args.length === entry.args.length &&
    args.every((value, index) => value === entry.args[index]) &&
    Object.entries(entry.env).every(([key, value]) => env[key] === value)
  )
}

async function writeIfChanged(file: string, content: string): Promise<void> {
  try {
    if ((await readFile(file, 'utf8')) === content) return
  } catch {
    // Missing or unreadable: fall through to the write.
  }
  await writeFile(file, content, 'utf8')
  logger.info(`Updated ${file}`)
}

/**
 * agy accepts line and block comments and trailing commas in
 * `mcp_config.json`, so a strict parse would reject a file it considers valid.
 * Strip both before parsing.
 *
 * A file that still will not parse is never treated as empty: writing a fresh
 * object would delete every other MCP server the user configured. The turn
 * fails with an actionable message instead.
 */
async function readMcpConfig(file: string): Promise<unknown> {
  let raw: string
  try {
    raw = await readFile(file, 'utf8')
  } catch {
    return null
  }
  if (!raw.trim()) return null

  const stripped = raw
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:"'\\])\/\/[^\n\r]*/g, '$1')
    .replace(/,(\s*[}\]])/g, '$1')
  try {
    return JSON.parse(stripped)
  } catch (error) {
    logger.error(`Could not parse ${file}`, error)
    throw markExpectedCondition(
      new Error(
        `Antigravity CLI's MCP config could not be read (${file}). Fix or remove that file, then try again.`
      )
    )
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
