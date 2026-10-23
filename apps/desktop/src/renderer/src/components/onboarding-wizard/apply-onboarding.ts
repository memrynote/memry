import type { SelectVaultResponse } from '@memry/contracts/vault-api'
import { toast } from 'sonner'
import { persistAgentModelPreference } from '@/agent-chat/agent-model-preference'
import { recordOnboarded } from '@/components/onboarding/onboarding-record'
import { STAR_PROMPT_KEY } from '@/components/onboarding/star-prompt'
import { getTelemetryApi } from '@/hooks/use-telemetry-settings'
import { createLogger } from '@/lib/logger'
import { trackTelemetry } from '@/lib/telemetry'
import { vaultService } from '@/services/vault-service'
import { finishFirstRunWizard } from './first-run-store'
import {
  activeImports,
  themeSettingsFor,
  type ImportChoice,
  type WizardDraft
} from './wizard-model'

const log = createLogger('Onboarding:Apply')

type Translate = (key: string, options?: Record<string, unknown>) => string

export type ApplyResult = { ok: true } | { ok: false; error: SelectVaultResponse }

async function settle(
  label: string,
  write: Promise<{ success: boolean; error?: string }>
): Promise<void> {
  try {
    const result = await write
    if (!result.success) log.warn(`Onboarding could not save ${label}`, result.error)
  } catch (error) {
    log.warn(`Onboarding could not save ${label}`, error)
  }
}

function startImport(choice: ImportChoice, t: Translate): void {
  window.api.import
    .start({
      importId: crypto.randomUUID(),
      importerId: choice.importerId,
      sourcePaths: choice.sourcePaths
    })
    .then((result) => {
      if ('error' in result) throw new Error(String(result.error))
      toast.success(t('onboardingWizard.ready.importDone', { source: choice.label }))
    })
    .catch((error) => {
      log.warn('Onboarding import failed', { importer: choice.importerId, error })
      toast.error(t('onboardingWizard.ready.importFailed', { source: choice.label }))
    })
}

function markOnboarded(): void {
  // The wizard replaces the sidebar tour; the star card still gets its turn.
  recordOnboarded().catch((error) => {
    log.warn('Recording onboarding failed', error)
  })
  try {
    if (localStorage.getItem(STAR_PROMPT_KEY) === null)
      localStorage.setItem(STAR_PROMPT_KEY, 'pending')
  } catch (error) {
    log.warn('Arming the star prompt failed', error)
  }
}

function complete(path: 'new' | 'returning'): void {
  markOnboarded()
  void trackTelemetry('onboarding_completed', {
    surface: 'onboarding',
    action: path,
    result: 'success'
  })
  finishFirstRunWizard()
}

/**
 * Opens the vault the user set up and writes their choices into it before the
 * app mounts. A folder that is already a Memry vault keeps its own settings and
 * gets no imports.
 */
export async function applyNewUser(
  draft: WizardDraft,
  existingVault: boolean,
  t: Translate
): Promise<ApplyResult> {
  const folder = draft.folder
  if (!folder) return { ok: false, error: { success: false, vault: null, error: 'no-folder' } }

  await getTelemetryApi()?.setEnabled(draft.telemetry)

  const opened =
    folder.kind === 'new'
      ? await vaultService.create(folder.parent, folder.name)
      : await vaultService.select(folder.path)
  if (!opened.success) return { ok: false, error: opened }

  if (!existingVault) {
    await Promise.all([
      settle(
        'appearance',
        window.api.settings.setGeneralSettings(themeSettingsFor(draft.theme, draft.editorTheme))
      ),
      settle('modules', window.api.settings.setFeaturesSettings(draft.features)),
      settle('AI setting', window.api.settings.setAISettings({ enabled: draft.aiEnabled }))
    ])
    for (const choice of activeImports(draft)) startImport(choice, t)
  }
  if (draft.aiEnabled && draft.agent) {
    persistAgentModelPreference({ provider: draft.agent, models: {} })
  }
  complete('new')
  return { ok: true }
}

/** The returning user's vault is already open; it brings its own synced settings. */
export function applyReturningUser(): void {
  complete('returning')
}
