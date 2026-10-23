import { useEffect, useReducer, useState } from 'react'
import { useT } from '@memry/i18n/renderer'
import { useAuth } from '@/contexts/auth-context'
import { trackTelemetry } from '@/lib/telemetry'
import { StagePreview, type StageFocus } from './stage-preview'
import { AccountStep } from './steps/account-step'
import { AgentStep, startSmartConnectionsDownload } from './steps/agent-step'
import {
  ModulesStep,
  StorageStep,
  ThemeStep,
  WelcomeStep,
  type ModuleKey
} from './steps/basic-steps'
import { ImportStep } from './steps/import-step'
import { PlanStep } from './steps/plan-step'
import { ReadyStep } from './steps/ready-step'
import { VaultStep } from './steps/vault-step'
import {
  initialDraft,
  progressFor,
  wizardReducer,
  type StepId,
  type WizardState
} from './wizard-model'
import { LocaleSelect } from '@/components/onboarding/locale-select'
import { Globe } from '@/lib/icons'
import { cn } from '@/lib/utils'
import { MUTED, ProgressDots, WizardFrame, type KeyHint } from './wizard-ui'

const STAGE_FOCUS: Record<ModuleKey, StageFocus> = {
  home: 'home',
  inbox: 'inbox',
  journal: 'journal',
  tasks: 'tasks',
  calendar: 'calendar',
  graph: 'graph',
  spatialCanvas: 'canvas',
  ai: 'agent'
}

/** Steps whose own forms own the keyboard; Enter and Esc stay with them. */
const SELF_KEYED: ReadonlySet<StepId> = new Set(['account', 'ready', 'vault'])

/** Steps whose Continue hint is a button that moves on, like their Enter key. */
const HINT_CONTINUES: ReadonlySet<StepId> = new Set([
  'theme',
  'modules',
  'import',
  'agent',
  'storage'
])

/** Hints before Continue and Back: the keys that move through the step's options. */
const DEFAULT_CHOICE_HINTS: [string[], string][] = [[['↑', '↓'], 'choose']]
const CHOICE_HINTS: Partial<Record<StepId, [string[], string][]>> = {
  theme: [[['←', '→'], 'choose']],
  modules: [
    [['↑', '↓'], 'move'],
    [['Space'], 'toggle']
  ],
  import: [
    [['↑', '↓'], 'choose'],
    [['Space'], 'select']
  ]
}

/** Steps that show the mini app window under their content. Import and Ready
 * have long lists, so the window would only show as a sliver. */
const STAGED: ReadonlySet<StepId> = new Set([
  'welcome',
  'theme',
  'modules',
  'agent',
  'storage',
  'account',
  'vault'
])

function isTyping(target: EventTarget | null): boolean {
  return (
    target instanceof HTMLElement &&
    (target.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName))
  )
}

function useWizardKeys(state: WizardState, back: () => void): void {
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.metaKey || event.ctrlKey || event.altKey || isTyping(event.target)) return
      if (event.key === 'Escape' && state.step !== 'welcome') {
        event.preventDefault()
        back()
        return
      }
      if (event.key !== 'Enter' || SELF_KEYED.has(state.step)) return
      // Enter on an option or on nothing focused continues, as the hint says.
      const target = event.target as HTMLElement | null
      if (target && target !== document.body && !target.hasAttribute('data-wizard-option')) return
      const next = document.querySelector<HTMLButtonElement>(
        '[data-wizard-continue]:not([disabled])'
      )
      if (!next) return
      event.preventDefault()
      next.click()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => {
      window.removeEventListener('keydown', onKeyDown)
    }
  }, [state.step, back])
}

export function OnboardingWizard(): React.JSX.Element {
  const { t } = useT('common')
  const [state, dispatch] = useReducer(wizardReducer, undefined, (): WizardState => ({
    path: 'new',
    step: 'welcome',
    draft: initialDraft(true)
  }))
  const [focusedModule, setFocusedModule] = useState<ModuleKey>('journal')

  useEffect(() => {
    void trackTelemetry('onboarding_started', { surface: 'onboarding', action: 'wizard' })
  }, [])

  const back = (): void => {
    dispatch({ type: 'back' })
  }
  useWizardKeys(state, back)

  const progress = progressFor(state)
  const props = { state, dispatch }
  const key = (name: string): string => t(`onboardingWizard.keys.${name}`)
  const backHint: KeyHint = { keys: ['esc'], label: key('back'), onPress: back }
  const continueHint: KeyHint = HINT_CONTINUES.has(state.step)
    ? {
        keys: ['↵'],
        label: key('continue'),
        continues: true,
        onPress: () => {
          if (state.step === 'agent') startSmartConnectionsDownload()
          dispatch({ type: 'next' })
        }
      }
    : { keys: ['↵'], label: key('continue') }
  const lead = (CHOICE_HINTS[state.step] ?? DEFAULT_CHOICE_HINTS).map(([keys, label]): KeyHint => ({
    keys,
    label: key(label)
  }))
  const hints: KeyHint[] =
    state.step === 'welcome'
      ? []
      : SELF_KEYED.has(state.step)
        ? [backHint]
        : [...lead, continueHint, backHint]
  // A module that is off has no pane to show: fall back to Home, or Journal without it.
  const focusedOn =
    focusedModule === 'ai' ? state.draft.aiEnabled : state.draft.features[focusedModule]
  const moduleFocus: StageFocus = focusedOn
    ? STAGE_FOCUS[focusedModule]
    : state.draft.features.home
      ? 'home'
      : 'journal'
  const stageFocus: StageFocus =
    state.step === 'modules' ? moduleFocus : state.step === 'agent' ? 'agent' : 'journal'
  // The recovery phrase screens need the room, and the design draws them without the window.
  const authStep = useAuth().state.wizardStep
  const phraseOnScreen =
    state.step === 'account' &&
    (authStep === 'recovery-display' ||
      authStep === 'recovery-confirm' ||
      authStep === 'recovery-input')
  const stage =
    STAGED.has(state.step) && !phraseOnScreen ? (
      <StagePreview
        features={state.draft.features}
        aiEnabled={state.draft.aiEnabled}
        focus={stageFocus}
      />
    ) : undefined
  const language =
    state.step === 'welcome' ? (
      <span className={cn('flex items-center gap-1.5', MUTED)}>
        <Globe className="size-3.5" aria-hidden="true" />
        <LocaleSelect
          ariaLabel={t('onboardingWizard.welcome.language')}
          side="bottom"
          className="h-5 w-auto gap-1.5 border-0 bg-transparent p-0 text-xs text-current hover:text-foreground [&>svg]:size-3 [&>svg]:opacity-100"
        />
      </span>
    ) : undefined

  return (
    <WizardFrame hints={hints} headerEnd={language} stage={stage}>
      {progress.index >= 0 && (
        <div className="pt-3.5">
          <ProgressDots index={progress.index} total={progress.total} />
        </div>
      )}
      <div key={state.step} className="wizard-step-enter flex w-full flex-col items-center">
        {state.step === 'welcome' && <WelcomeStep {...props} />}
        {state.step === 'theme' && <ThemeStep {...props} />}
        {state.step === 'modules' && (
          <ModulesStep {...props} focused={focusedModule} onFocusModule={setFocusedModule} />
        )}
        {state.step === 'import' && <ImportStep {...props} />}
        {state.step === 'agent' && <AgentStep {...props} />}
        {state.step === 'storage' && <StorageStep {...props} />}
        {state.step === 'account' && <AccountStep {...props} />}
        {state.step === 'plan' && <PlanStep {...props} />}
        {state.step === 'ready' && <ReadyStep {...props} />}
        {state.step === 'vault' && <VaultStep {...props} />}
      </div>
    </WizardFrame>
  )
}
