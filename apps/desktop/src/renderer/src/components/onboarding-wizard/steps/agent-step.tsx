import { useEffect, useState } from 'react'
import type { AgentBackendId } from '@memry/contracts/ipc-agent'
import type { OnboardingAgentStatus } from '@memry/contracts/onboarding-api'
import { useT } from '@memry/i18n/renderer'
import { ArrowUpRight, Check, Info } from '@/lib/icons'
import { createLogger } from '@/lib/logger'
import { cn } from '@/lib/utils'
import {
  MUTED,
  OptionList,
  RadioMark,
  SELECTED_RING,
  SectionLabel,
  StepHeading,
  useDeviceLabel
} from '../wizard-ui'
import type { StepProps } from './basic-steps'

const log = createLogger('Onboarding:Agent')
const K = 'onboardingWizard.agent'

const BACKENDS: AgentBackendId[] = [
  'claude_cli',
  'codex_cli',
  'antigravity_cli',
  'local_openai_compatible'
]

const INSTALL_URL: Record<AgentBackendId, string> = {
  claude_cli: 'https://docs.anthropic.com/en/docs/claude-code/setup',
  codex_cli: 'https://github.com/openai/codex#installation',
  antigravity_cli: 'https://antigravity.google/download',
  local_openai_compatible: 'https://ollama.com/download'
}

const STATE_KEY: Record<OnboardingAgentStatus['state'], string> = {
  found: 'found',
  outdated: 'outdated',
  missing: 'missing',
  not_running: 'notRunning'
}

/** Starts the model download as the user leaves this step, so it runs while they finish. */
export function startSmartConnectionsDownload(): void {
  window.api.settings
    .loadAIModel()
    .then((result) => {
      if (!result.success) log.warn('Smart connections model did not load', result.error)
    })
    .catch((error) => log.warn('Starting the smart connections download failed', error))
}

export function AgentStep({ state, dispatch }: StepProps): React.JSX.Element {
  const { t } = useT('common')
  const device = useDeviceLabel()
  const [statuses, setStatuses] = useState<OnboardingAgentStatus[] | null>(null)

  useEffect(() => {
    let cancelled = false
    window.api.onboarding
      .detectAgents()
      .then((found) => {
        if (cancelled) return
        setStatuses(found)
        // Preselect the first agent that is ready, unless the user already chose.
        const ready = found.find((status) => status.state === 'found')
        if (ready && state.draft.agent === null) {
          dispatch({ type: 'update', patch: { agent: ready.backend } })
        }
      })
      .catch((error) => {
        log.warn('Detecting agents failed', error)
        if (!cancelled) setStatuses([])
      })
    return () => {
      cancelled = true
    }
    // Detection runs once per visit; the preselect reads the draft at that moment.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const stateOf = (backend: AgentBackendId): OnboardingAgentStatus | undefined =>
    statuses?.find((status) => status.backend === backend)
  const noneFound = statuses !== null && !statuses.some((status) => status.state === 'found')

  const install = (backend: AgentBackendId): void => {
    window.open(INSTALL_URL[backend], '_blank', 'noopener,noreferrer')
  }

  return (
    <>
      <StepHeading title={t(`${K}.title`)} body={t(`${K}.body`)} />
      <div className="flex flex-wrap items-start justify-center gap-7 pt-6">
        <OptionList role="radiogroup" label={t(`${K}.section`)} className="w-[340px] gap-0.5">
          <SectionLabel className="px-2.5">{t(`${K}.section`)}</SectionLabel>
          {BACKENDS.map((backend) => {
            const status = stateOf(backend)
            const ready = status?.state === 'found'
            const selected = state.draft.agent === backend
            return (
              <div
                key={backend}
                className={cn(
                  'flex h-[46px] items-center gap-3 rounded-md pe-2.5 transition-colors duration-150 motion-reduce:transition-none',
                  selected ? SELECTED_RING : ready && 'hover:bg-surface/60'
                )}
              >
                <button
                  type="button"
                  role="radio"
                  aria-checked={selected}
                  data-wizard-option
                  disabled={!ready}
                  onClick={() => dispatch({ type: 'update', patch: { agent: backend } })}
                  // A radio follows focus, so arrowing through the list picks as it goes.
                  onFocus={
                    selected
                      ? undefined
                      : () => dispatch({ type: 'update', patch: { agent: backend } })
                  }
                  className="flex h-full min-w-0 grow items-center gap-3 rounded-md ps-2.5 text-start focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-default"
                >
                  <RadioMark on={selected} />
                  <span className="flex min-w-0 flex-col gap-px">
                    <span className="text-[13.5px] font-medium leading-[18px] text-foreground">
                      {t(`${K}.${backend}`)}
                    </span>
                    <span className={cn('truncate text-xs leading-4', MUTED)}>
                      {t(`${K}.${backend}Hint`)}
                    </span>
                  </span>
                </button>
                <span className="flex w-20 shrink-0 justify-end">
                  {!status ? (
                    <span className={cn('text-xs', MUTED)}>{t(`${K}.checking`)}</span>
                  ) : ready ? (
                    // Green fails AA as small text on light canvases, so it marks the icon only.
                    <span className="flex items-center gap-1 text-xs font-medium text-foreground">
                      <Check className="size-3 text-[var(--task-complete)]" />
                      {t(`${K}.found`)}
                    </span>
                  ) : noneFound ? (
                    <button
                      type="button"
                      onClick={() => install(backend)}
                      className="flex items-center gap-1 rounded-sm text-xs font-semibold text-foreground hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                    >
                      {t(backend === 'local_openai_compatible' ? `${K}.setUp` : `${K}.install`)}
                      <ArrowUpRight className="size-3 mirror-rtl" />
                    </button>
                  ) : (
                    <span className={cn('text-xs', MUTED)}>
                      {t(`${K}.${STATE_KEY[status.state]}`)}
                    </span>
                  )}
                </span>
              </div>
            )
          })}
          {noneFound && (
            <p className={cn('flex gap-2 px-2.5 pt-3 text-[12.5px] leading-[18px]', MUTED)}>
              <Info className="mt-0.5 size-3.5 shrink-0" />
              {t(`${K}.noneFound`)}
            </p>
          )}
        </OptionList>
        <div className="flex w-[260px] flex-col gap-0.5">
          <SectionLabel>{t(`${K}.onDevice`, { device })}</SectionLabel>
          <div className="flex flex-col gap-2 rounded-[10px] border border-border px-3.5 pb-3.5 pt-3">
            <span className="text-[13.5px] font-medium leading-[18px] text-foreground">
              {t(`${K}.smartTitle`)}
            </span>
            <span className={cn('text-[12.5px] leading-[18px]', MUTED)}>{t(`${K}.smartBody`)}</span>
            <span className="h-px shrink-0 bg-border" />
            <span className={cn('text-xs leading-[17px]', MUTED)}>
              {t(`${K}.smartDetail`, { device })}
            </span>
          </div>
        </div>
      </div>
    </>
  )
}
