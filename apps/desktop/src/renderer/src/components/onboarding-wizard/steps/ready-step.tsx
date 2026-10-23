import { useEffect, useState, type Dispatch, type ReactNode } from 'react'
import { useT } from '@memry/i18n/renderer'
import { Button } from '@/components/ui/button'
import { Switch } from '@/components/ui/switch'
import { useAuth } from '@/contexts/auth-context'
import { Cloud, Download, FileText, Shield, Sparkles } from '@/lib/icons'
import { createLogger } from '@/lib/logger'
import { cn } from '@/lib/utils'
import { vaultService } from '@/services/vault-service'
import { applyNewUser } from '../apply-onboarding'
import {
  activeImports,
  type FolderChoice,
  type WizardAction,
  type WizardDraft
} from '../wizard-model'
import { ContinueButton, MUTED, StepHeading, useDeviceLabel } from '../wizard-ui'
import type { StepProps } from './basic-steps'

const log = createLogger('Onboarding:Ready')
const K = 'onboardingWizard.ready'

function folderPath(folder: FolderChoice): string {
  if (folder.kind === 'existing') return folder.path
  const sep = folder.parent.includes('\\') ? '\\' : '/'
  return folder.parent.endsWith(sep)
    ? `${folder.parent}${folder.name}`
    : `${folder.parent}${sep}${folder.name}`
}

function Row({
  icon,
  title,
  children,
  end
}: {
  icon: ReactNode
  title: ReactNode
  children?: ReactNode
  end?: ReactNode
}): React.JSX.Element {
  return (
    <div className="flex items-start gap-3 px-1 py-3.5 [&+&]:border-t [&+&]:border-border">
      <span className="flex w-[18px] shrink-0 justify-center pt-px text-text-tertiary [&_svg]:size-[15px]">
        {icon}
      </span>
      <div className="flex min-w-0 grow flex-col gap-[3px]">
        {typeof title === 'string' ? (
          <span className="truncate text-[13.5px] font-medium leading-[18px] text-foreground">
            {title}
          </span>
        ) : (
          title
        )}
        {children}
      </div>
      {end}
    </div>
  )
}

function Hint({ children }: { children: ReactNode }): React.JSX.Element {
  return <span className={cn('text-xs leading-[17px]', MUTED)}>{children}</span>
}

/** Download progress of the smart connections model the agent step started. */
function useModelProgress(): number | null {
  const [percent, setPercent] = useState<number | null>(null)
  useEffect(
    () =>
      window.api.onEmbeddingProgress((event) => {
        if (event.phase === 'downloading' || event.phase === 'loading') {
          setPercent(Math.round(event.progress ?? 0))
        } else if (event.phase === 'ready') {
          setPercent(100)
        }
      }),
    []
  )
  return percent
}

function ModelRow(): React.JSX.Element {
  const { t } = useT('common')
  const percent = useModelProgress()
  return (
    <Row
      icon={<Sparkles />}
      title={
        <span className="flex items-center justify-between gap-3">
          <span className="truncate text-[13.5px] font-medium leading-[18px] text-foreground">
            {t(`${K}.modelTitle`)}
          </span>
          {percent !== null && (
            <span className={cn('text-xs tabular-nums', MUTED)}>
              {t(`${K}.modelPercent`, { percent })}
            </span>
          )}
        </span>
      }
    >
      <span
        className="mt-[5px] flex h-1 overflow-hidden rounded-[2px] bg-surface-active"
        role="progressbar"
        aria-label={t(`${K}.modelTitle`)}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={percent ?? undefined}
      >
        <span
          className="h-full rounded-[2px] bg-foreground transition-[width] duration-300 motion-reduce:transition-none"
          style={{ width: `${percent ?? 0}%` }}
        />
      </span>
      <span className="pt-[5px]">
        <Hint>{t(`${K}.modelHint`)}</Hint>
      </span>
    </Row>
  )
}

/** Only on the sync path, where an account is signed in. */
function SyncRow({
  draft,
  disabled,
  dispatch
}: {
  draft: WizardDraft
  disabled: boolean
  dispatch: Dispatch<WizardAction>
}): React.JSX.Element {
  const { t } = useT('common')
  const device = useDeviceLabel()
  const email = useAuth().state.email ?? ''
  return (
    <Row
      icon={<Cloud />}
      title={t(`${K}.signedInAs`, { email })}
      end={
        draft.paidPlan ? undefined : (
          <Button
            variant="outline"
            size="sm"
            className="h-[30px] shrink-0 text-[12.5px] font-semibold shadow-none"
            disabled={disabled}
            onClick={() => dispatch({ type: 'goto', step: 'plan' })}
          >
            {t(`${K}.choosePlan`)}
          </Button>
        )
      }
    >
      <Hint>
        {draft.paidPlan
          ? t(`${K}.planActive`, { plan: t(`onboardingWizard.plan.${draft.paidPlan}`) })
          : t(`${K}.noPlan`, { device })}
      </Hint>
    </Row>
  )
}

const LINK =
  'rounded-sm transition-colors hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50'

export function ReadyStep({ state, dispatch }: StepProps): React.JSX.Element {
  const { t } = useT('common')
  const { draft } = state
  const [existingVault, setExistingVault] = useState(false)
  const [opening, setOpening] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (draft.folder) return
    vaultService
      .getDefaultParent()
      .then((parent) =>
        dispatch({
          type: 'update',
          patch: { folder: { kind: 'new', parent, name: t('onboardingWizard.preview.notesName') } }
        })
      )
      .catch((err) => log.warn('Reading the default vault folder failed', err))
    // Runs once: later folder changes come from the user.
    // oxlint-disable-next-line react/exhaustive-deps
  }, [])

  const pick = async (mode: 'parent' | 'existing'): Promise<void> => {
    setError(null)
    try {
      const { path } = await window.api.syncLinking.pickVaultFolder()
      if (!path) return
      if (mode === 'parent') {
        setExistingVault(false)
        dispatch({
          type: 'update',
          patch: {
            folder: { kind: 'new', parent: path, name: t('onboardingWizard.preview.notesName') }
          }
        })
        return
      }
      setExistingVault(await window.api.onboarding.isMemryVault(path))
      dispatch({ type: 'update', patch: { folder: { kind: 'existing', path } } })
    } catch (err) {
      log.warn('Picking a folder failed', err)
      setError(t(`${K}.failed`))
    }
  }

  const open = async (): Promise<void> => {
    setOpening(true)
    setError(null)
    const result = await applyNewUser(draft, existingVault, t).catch((err: unknown) => {
      log.error('Applying onboarding failed', err)
      return { ok: false as const }
    })
    if (!result.ok) {
      setOpening(false)
      setError(t(`${K}.failed`))
    }
  }

  const imports = existingVault ? [] : activeImports(draft)
  const sources = imports.map((choice) => choice.label).join(', ')

  return (
    <>
      <StepHeading title={t(`${K}.title`)} body={t(`${K}.body`)} />
      <div className="flex w-full max-w-[520px] flex-col pt-[26px]">
        {draft.storage === 'sync' && (
          <SyncRow draft={draft} disabled={opening} dispatch={dispatch} />
        )}
        <Row
          icon={<FileText />}
          title={t(`${K}.folder`)}
          end={
            <span className="flex shrink-0 flex-col items-end gap-1.5">
              <button
                type="button"
                disabled={opening}
                onClick={() => void pick('parent')}
                className={cn(LINK, 'text-[12.5px] font-semibold text-foreground')}
              >
                {t(`${K}.change`)}
              </button>
              <button
                type="button"
                disabled={opening}
                onClick={() => void pick('existing')}
                className={cn(LINK, 'text-xs hover:text-foreground', MUTED)}
              >
                {t(`${K}.useExisting`)}
              </button>
            </span>
          }
        >
          <span className={cn('truncate font-mono text-xs leading-4', MUTED)}>
            {draft.folder ? folderPath(draft.folder) : '…'}
          </span>
          <span className="pt-[3px]">
            <Hint>{existingVault ? t(`${K}.existingFolderHint`) : t(`${K}.folderHint`)}</Hint>
          </span>
        </Row>
        {imports.length > 0 && (
          <Row icon={<Download />} title={t(`${K}.importTitle`, { sources })}>
            <Hint>{t(`${K}.importHint`)}</Hint>
          </Row>
        )}
        {draft.aiEnabled && <ModelRow />}
        <Row
          icon={<Shield />}
          title={t(`${K}.metrics`)}
          end={
            <span className="pt-px">
              <Switch
                aria-label={t(`${K}.metrics`)}
                checked={draft.telemetry}
                onCheckedChange={(telemetry) => dispatch({ type: 'update', patch: { telemetry } })}
              />
            </span>
          }
        >
          <Hint>{t(`${K}.metricsHint`)}</Hint>
        </Row>
      </div>
      <div className="flex flex-col items-center gap-3.5 pt-[22px]">
        <ContinueButton
          label={opening ? t(`${K}.opening`) : t(`${K}.open`)}
          loading={opening}
          disabled={!draft.folder || opening}
          onClick={() => void open()}
        />
        {error && (
          <p role="alert" className="max-w-[420px] text-center text-xs text-destructive">
            {error}
          </p>
        )}
      </div>
    </>
  )
}
