/**
 * First-run wizard IPC. These run before any vault is open, so they cannot go
 * through the vault-scoped agent or import channels.
 *
 * @module shared/onboarding-api
 */

import type { AgentBackendId } from './ipc-agent'

export const OnboardingChannels = {
  invoke: {
    /** Which agent CLIs are installed and whether a local model server answers. */
    DETECT_AGENTS: 'onboarding:detect-agents',
    /** Note apps found on this computer, and Obsidian's known vaults. */
    DETECT_SOURCES: 'onboarding:detect-sources',
    /** Whether a folder the user picked is already a Memry vault. */
    IS_MEMRY_VAULT: 'onboarding:is-memry-vault'
  }
} as const

export type OnboardingAgentState = 'found' | 'outdated' | 'missing' | 'not_running'

export interface OnboardingAgentStatus {
  backend: AgentBackendId
  state: OnboardingAgentState
  version: string | null
}

export interface OnboardingObsidianVault {
  name: string
  path: string
}

export interface OnboardingSources {
  obsidianVaults: OnboardingObsidianVault[]
  /** Importer ids whose app is installed on this computer. */
  installedApps: string[]
}
