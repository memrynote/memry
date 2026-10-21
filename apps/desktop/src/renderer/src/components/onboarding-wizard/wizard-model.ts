import {
  FEATURES_SETTINGS_DEFAULTS,
  type FeaturesSettings
} from '@memry/contracts/settings-schemas'
import type { AgentBackendId } from '@memry/contracts/ipc-agent'

/**
 * First-run wizard model. The step list is derived from the draft, so a skip
 * rule (AI off drops the agent step, local storage drops the account and plan
 * steps) lives only in `stepsFor`, and back/next walk whatever list is current.
 */

export type WizardPath = 'new' | 'returning'

export type ThemeChoice = 'system' | 'white' | 'light' | 'dark'

export type StorageChoice = 'local' | 'sync'

export type PlanId = 'plus' | 'pro' | 'believer'
export type PlanCadence = 'monthly' | 'annual'

export interface PlanChoice {
  plan: PlanId
  cadence: PlanCadence
}

/** One import the user picked: an importer plus the paths it reads. */
export interface ImportChoice {
  /** Stable key for the list; one source can yield several choices (Obsidian vaults). */
  key: string
  importerId: string
  label: string
  sourcePaths: string[]
}

/** Where the new vault goes. `existing` adopts a folder the user picked. */
export type FolderChoice =
  { kind: 'new'; parent: string; name: string } | { kind: 'existing'; path: string }

export interface WizardDraft {
  theme: ThemeChoice
  features: FeaturesSettings
  aiEnabled: boolean
  imports: ImportChoice[]
  agent: AgentBackendId | null
  storage: StorageChoice
  plan: PlanChoice
  /** The plan the account pays for, once checkout went through. */
  paidPlan: PlanId | null
  folder: FolderChoice | null
  telemetry: boolean
}

export type StepId =
  | 'welcome'
  | 'theme'
  | 'modules'
  | 'import'
  | 'agent'
  | 'storage'
  | 'account'
  | 'plan'
  | 'ready'
  | 'vault'

export interface WizardState {
  path: WizardPath
  step: StepId
  draft: WizardDraft
}

export type WizardAction =
  | { type: 'start'; path: WizardPath }
  | { type: 'next' }
  | { type: 'back' }
  | { type: 'goto'; step: StepId }
  | { type: 'update'; patch: Partial<WizardDraft> }
  /** The new-account path met an email that already has an account. */
  | { type: 'reroute-to-returning' }
  /** A signed-in account with no vaults sets one up like a new user, synced. */
  | { type: 'switch-to-new' }

export function initialDraft(telemetry: boolean): WizardDraft {
  return {
    theme: 'system',
    features: { ...FEATURES_SETTINGS_DEFAULTS },
    aiEnabled: true,
    imports: [],
    agent: null,
    storage: 'local',
    plan: { plan: 'pro', cadence: 'annual' },
    paidPlan: null,
    folder: null,
    telemetry
  }
}

export function initialState(telemetry: boolean): WizardState {
  return { path: 'new', step: 'welcome', draft: initialDraft(telemetry) }
}

export function stepsFor(path: WizardPath, draft: WizardDraft): StepId[] {
  if (path === 'returning') return ['welcome', 'account', 'vault']
  const steps: StepId[] = ['welcome', 'theme', 'modules', 'import']
  if (draft.aiEnabled) steps.push('agent')
  steps.push('storage')
  if (draft.storage === 'sync') steps.push('account', 'plan')
  steps.push('ready')
  return steps
}

/** Dots shown in the progress row: every step but the welcome screen. */
export function progressFor(state: WizardState): { index: number; total: number } {
  const steps: StepId[] = stepsFor(state.path, state.draft).filter((step) => step !== 'welcome')
  return { index: steps.indexOf(state.step), total: steps.length }
}

/** Importers that write into a module the user turned off are hidden. */
const IMPORTER_MODULE: Partial<Record<string, keyof FeaturesSettings>> = {
  todoist: 'tasks',
  ticktick: 'tasks',
  noteplan: 'journal',
  'apple-journal': 'journal'
}

export function isImporterVisible(importerId: string, features: FeaturesSettings): boolean {
  const module = IMPORTER_MODULE[importerId]
  return module === undefined || features[module]
}

/** Imports still valid for the current module set. */
export function activeImports(draft: WizardDraft): ImportChoice[] {
  return draft.imports.filter((choice) => isImporterVisible(choice.importerId, draft.features))
}

function move(state: WizardState, delta: 1 | -1): WizardState {
  const steps = stepsFor(state.path, state.draft)
  const index = steps.indexOf(state.step)
  const target = steps[index + delta]
  return target ? { ...state, step: target } : state
}

export function wizardReducer(state: WizardState, action: WizardAction): WizardState {
  switch (action.type) {
    case 'start':
      return move({ ...state, path: action.path, step: 'welcome' }, 1)
    case 'next':
      return move(state, 1)
    case 'back':
      if (state.step === 'welcome') return state
      return move(state, -1)
    case 'goto':
      return stepsFor(state.path, state.draft).includes(action.step)
        ? { ...state, step: action.step }
        : state
    case 'update':
      return { ...state, draft: { ...state.draft, ...action.patch } }
    case 'reroute-to-returning':
      // The account brings its own synced settings, so local picks are dropped.
      // Theme stays so the remaining wizard screens don't flip appearance.
      return {
        path: 'returning',
        step: 'account',
        draft: { ...initialDraft(state.draft.telemetry), theme: state.draft.theme }
      }
    case 'switch-to-new':
      return { path: 'new', step: 'theme', draft: { ...state.draft, storage: 'sync' } }
  }
}

/** Stored theme fields for a choice; warm paper is a color theme, not a mode. */
export function themeSettingsFor(choice: ThemeChoice): {
  theme: 'system' | 'white' | 'light' | 'dark'
  colorTheme: 'memrynote' | 'warm'
} {
  return { theme: choice, colorTheme: choice === 'light' ? 'warm' : 'memrynote' }
}
