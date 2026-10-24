import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, join } from 'node:path'
import { app } from 'electron'
import type { BinaryStatus } from '@memry/contracts/ipc-agent'
import type {
  OnboardingAgentStatus,
  OnboardingObsidianVault,
  OnboardingSources
} from '@memry/contracts/onboarding-api'
import { detectAgyBinary } from '../agent/cli/agy-binary'
import { detectClaudeBinary } from '../agent/cli/claude-binary'
import { detectCodexBinary } from '../agent/cli/codex-binary'
import { LOCAL_PROVIDER_PRESETS } from '../agent/backends/local-provider-settings'
import { createLogger } from '../lib/logger'

const log = createLogger('Onboarding:Detect')

const LOCAL_SERVER_TIMEOUT_MS = 1500

function cliState(status: BinaryStatus): OnboardingAgentStatus['state'] {
  if (!status.detected) return 'missing'
  return status.meetsMinimum ? 'found' : 'outdated'
}

async function localServerAnswers(baseUrl: string): Promise<boolean> {
  try {
    const response = await fetch(`${baseUrl}/models`, {
      signal: AbortSignal.timeout(LOCAL_SERVER_TIMEOUT_MS)
    })
    return response.ok
  } catch {
    return false
  }
}

export async function detectAgents(): Promise<OnboardingAgentStatus[]> {
  const [claude, codex, agy, ollama, lmStudio] = await Promise.all([
    detectClaudeBinary(),
    detectCodexBinary(),
    detectAgyBinary(),
    localServerAnswers(LOCAL_PROVIDER_PRESETS.ollama.baseUrl),
    localServerAnswers(LOCAL_PROVIDER_PRESETS.lm_studio.baseUrl)
  ])
  return [
    { backend: 'claude_cli', state: cliState(claude), version: claude.version },
    { backend: 'codex_cli', state: cliState(codex), version: codex.version },
    { backend: 'antigravity_cli', state: cliState(agy), version: agy.version },
    {
      backend: 'local_openai_compatible',
      state: ollama || lmStudio ? 'found' : 'not_running',
      version: null
    }
  ]
}

/** Obsidian's own vault registry, the same file on every platform under appData. */
export async function readObsidianVaults(configPath: string): Promise<OnboardingObsidianVault[]> {
  let raw: string
  try {
    raw = await readFile(configPath, 'utf8')
  } catch {
    return []
  }
  try {
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- JSON.parse returns any; the cast is an all-optional shape and path is checked with typeof before use
    const parsed = JSON.parse(raw) as { vaults?: Record<string, { path?: unknown }> }
    return Object.values(parsed.vaults ?? {})
      .map((vault) => vault.path)
      .filter((path): path is string => typeof path === 'string' && existsSync(path))
      .map((path) => ({ name: basename(path), path }))
  } catch (error) {
    log.warn('Unreadable Obsidian vault registry', { configPath, error })
    return []
  }
}

/** macOS app bundle names per importer id. */
const MAC_APPS: Record<string, string[]> = {
  notion: ['Notion.app'],
  evernote: ['Evernote.app'],
  bear: ['Bear.app'],
  onenote: ['Microsoft OneNote.app'],
  noteplan: ['NotePlan 3.app', 'NotePlan.app'],
  todoist: ['Todoist.app'],
  ticktick: ['TickTick.app']
}

function installedMacApps(): string[] {
  const roots = ['/Applications', join(homedir(), 'Applications')]
  return Object.entries(MAC_APPS)
    .filter(([, bundles]) =>
      bundles.some((bundle) => roots.some((root) => existsSync(join(root, bundle))))
    )
    .map(([importerId]) => importerId)
}

export async function detectSources(): Promise<OnboardingSources> {
  const obsidianVaults = await readObsidianVaults(
    join(app.getPath('appData'), 'obsidian', 'obsidian.json')
  )
  return {
    obsidianVaults,
    installedApps: process.platform === 'darwin' ? installedMacApps() : []
  }
}
