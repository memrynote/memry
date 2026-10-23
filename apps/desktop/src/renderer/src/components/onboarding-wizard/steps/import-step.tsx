import { useEffect, useState } from 'react'
import type { ImporterMeta } from '@memry/contracts/import-channels'
import type { OnboardingSources } from '@memry/contracts/onboarding-api'
import { useT } from '@memry/i18n/renderer'
import { hasSourceLogo, ImportSourceIcon } from '@/components/import/import-source-icon'
import { ChevronRight, Lock, Plus } from '@/lib/icons'
import { createLogger } from '@/lib/logger'
import { cn } from '@/lib/utils'
import { activeImports, isImporterVisible, type ImportChoice } from '../wizard-model'
import {
  CheckMark,
  ContinueButton,
  MUTED,
  OptionList,
  QuietLink,
  SELECTED_RING,
  SectionLabel,
  StepHeading,
  useDeviceLabel
} from '../wizard-ui'
import type { StepProps } from './basic-steps'

const log = createLogger('Onboarding:Import')
const K = 'onboardingWizard.import'

const ROW =
  'flex w-full items-center gap-3 rounded-[10px] px-3 text-start transition-colors duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring motion-reduce:transition-none'

/** Shown up front: the sources most people bring, plus whatever is installed. */
const FEATURED = new Set(['apple-notes', 'notion'])

function baseName(path: string): string {
  return path.split(/[\\/]/).findLast(Boolean) ?? path
}

function useImportSources(): { importers: ImporterMeta[]; sources: OnboardingSources | null } {
  const [importers, setImporters] = useState<ImporterMeta[]>([])
  const [sources, setSources] = useState<OnboardingSources | null>(null)
  useEffect(() => {
    let cancelled = false
    window.api.import
      .list()
      .then((list) => !cancelled && setImporters(list.filter((meta) => !meta.accountBased)))
      .catch((error: unknown) => log.warn('Listing importers failed', error))
    window.api.onboarding
      .detectSources()
      .then((found) => !cancelled && setSources(found))
      .catch((error: unknown) => {
        log.warn('Detecting import sources failed', error)
        if (!cancelled) setSources({ obsidianVaults: [], installedApps: [] })
      })
    return () => {
      cancelled = true
    }
  }, [])
  return { importers, sources }
}

/** A source logo on a white tile, so transparent marks read on dark themes too. */
function SourceTile({
  id,
  name,
  small
}: {
  id: string
  name: string
  small?: boolean
}): React.JSX.Element {
  return (
    <span
      className={cn(
        'flex shrink-0 items-center justify-center overflow-hidden bg-white ring-1 ring-inset ring-black/10',
        small ? 'size-6 rounded-md ring-2 ring-background' : 'size-7 rounded-[7px]'
      )}
    >
      <ImportSourceIcon
        id={id}
        name={name}
        className={cn(small ? 'size-5' : 'size-[22px]', 'rounded-[5px] border-0 text-neutral-500')}
      />
    </span>
  )
}

export function ImportStep({ state, dispatch }: StepProps): React.JSX.Element {
  const { t } = useT('common')
  const device = useDeviceLabel()
  const { importers, sources } = useImportSources()
  const [showOthers, setShowOthers] = useState(false)
  const chosen = activeImports(state.draft)

  const setImports = (imports: ImportChoice[]): void =>
    dispatch({ type: 'update', patch: { imports } })
  const isChosen = (key: string): boolean => chosen.some((choice) => choice.key === key)
  const remove = (key: string): void => setImports(chosen.filter((choice) => choice.key !== key))

  const pick = async (meta: ImporterMeta): Promise<void> => {
    if (isChosen(meta.id)) {
      remove(meta.id)
      return
    }
    try {
      const result = await window.api.import.pickFiles({
        label: meta.fileSpec.label,
        extensions: meta.fileSpec.extensions,
        allowMultiple: meta.fileSpec.allowMultiple,
        directory: meta.fileSpec.directory,
        defaultPath: meta.fileSpec.defaultPath,
        message: meta.fileSpec.message
      })
      if (result.canceled) return
      setImports([
        ...chosen,
        { key: meta.id, importerId: meta.id, label: meta.name, sourcePaths: result.filePaths }
      ])
    } catch (error) {
      log.warn('Picking import files failed', { importer: meta.id, error })
    }
  }

  const toggleVault = (path: string): void => {
    const key = `obsidian:${path}`
    if (isChosen(key)) return remove(key)
    // An Obsidian vault is a folder of Markdown, which the Markdown importer reads.
    setImports([...chosen, { key, importerId: 'markdown', label: 'Obsidian', sourcePaths: [path] }])
  }

  const visible = importers.filter((meta) => isImporterVisible(meta.id, state.draft.features))
  const installed = new Set(sources?.installedApps ?? [])
  const featured = visible.filter((meta) => FEATURED.has(meta.id) || installed.has(meta.id))
  const others = visible.filter((meta) => !featured.includes(meta))
  const vaults = sources?.obsidianVaults ?? []

  const sourceRow = (meta: ImporterMeta): React.JSX.Element => {
    const choice = chosen.find((item) => item.key === meta.id)
    const hintKey = `${K}.hint.${meta.id}`
    const hint = t(hintKey)
    const detail = choice
      ? choice.sourcePaths.map(baseName).join(', ')
      : hint === hintKey
        ? undefined
        : hint
    return (
      <button
        key={meta.id}
        type="button"
        // oxlint-disable-next-line jsx-a11y/prefer-tag-over-role -- ARIA widget pattern; native tag would change styling or behavior
        role="checkbox"
        aria-checked={!!choice}
        data-wizard-option
        onClick={() => void pick(meta)}
        className={cn(ROW, 'min-h-[52px] py-2', choice ? SELECTED_RING : 'hover:bg-surface/60')}
      >
        <SourceTile id={meta.id} name={meta.name} />
        <span className="flex min-w-0 grow flex-col gap-px">
          <span className="text-[13.5px] font-semibold leading-[18px] text-foreground">
            {meta.name}
          </span>
          {detail && <span className={cn('truncate text-xs leading-4', MUTED)}>{detail}</span>}
        </span>
        <span className="flex h-7 shrink-0 items-center rounded-[7px] border border-border px-[11px] text-[12.5px] font-medium text-foreground">
          {choice
            ? t(`${K}.remove`)
            : t(meta.fileSpec.directory ? `${K}.choose` : `${K}.chooseFile`)}
        </span>
      </button>
    )
  }
  const vaultsChosen = vaults.filter((vault) => isChosen(`obsidian:${vault.path}`)).length

  return (
    <>
      <StepHeading title={t(`${K}.title`)} body={t(`${K}.body`)} />
      <OptionList label={t(`${K}.title`)} className="w-full max-w-[540px] gap-0.5 pt-[22px]">
        <SectionLabel className="px-3">{t(`${K}.onDevice`, { device })}</SectionLabel>
        {vaults.length > 0 && (
          <div
            className={cn(
              'flex flex-col gap-1.5 rounded-[10px] px-3 py-2.5',
              vaultsChosen > 0 ? SELECTED_RING : 'ring-1 ring-inset ring-border'
            )}
          >
            <span className="flex items-center gap-3">
              <SourceTile id="obsidian" name="Obsidian" />
              <span className="flex min-w-0 grow flex-col gap-px">
                <span className="text-[13.5px] font-semibold leading-[18px] text-foreground">
                  {t(`${K}.obsidian`)}
                </span>
                <span className={cn('text-xs leading-4', MUTED)}>
                  {t(`${K}.vaultsFound`, { count: vaults.length })}
                </span>
              </span>
              {vaultsChosen > 0 && (
                <span className="text-xs font-medium text-foreground">
                  {t(`${K}.vaultsSelected`, { count: vaultsChosen })}
                </span>
              )}
            </span>
            <div className="flex flex-col">
              {vaults.map((vault) => (
                <button
                  key={vault.path}
                  type="button"
                  // oxlint-disable-next-line jsx-a11y/prefer-tag-over-role -- ARIA widget pattern; native tag would change styling or behavior
                  role="checkbox"
                  aria-checked={isChosen(`obsidian:${vault.path}`)}
                  data-wizard-option
                  onClick={() => toggleVault(vault.path)}
                  className="flex h-[30px] items-center gap-2.5 rounded-md px-2 text-start hover:bg-surface-active/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                >
                  <CheckMark on={isChosen(`obsidian:${vault.path}`)} />
                  <span className="min-w-[76px] max-w-[160px] shrink-0 truncate text-[13px] font-medium text-foreground">
                    {vault.name}
                  </span>
                  <span className={cn('truncate font-mono text-[11.5px]', MUTED)}>
                    {vault.path}
                  </span>
                </button>
              ))}
            </div>
          </div>
        )}
        {featured.map(sourceRow)}
        {others.length > 0 && (
          <>
            <div className="my-0.5 h-px shrink-0 bg-border" />
            <button
              type="button"
              aria-expanded={showOthers}
              onClick={() => setShowOthers((open) => !open)}
              className={cn(ROW, 'h-12 hover:bg-surface/60')}
            >
              <span className="flex size-7 shrink-0 items-center justify-center rounded-[7px] ring-1 ring-inset ring-border">
                <Plus className="size-3.5 text-text-secondary" />
              </span>
              <span className="grow text-[13.5px] font-semibold leading-[18px] text-foreground">
                {t(`${K}.otherApps`)}
              </span>
              {!showOthers && (
                <span className="flex -space-x-1.5 rtl:space-x-reverse" aria-hidden="true">
                  {others
                    .filter((meta) => hasSourceLogo(meta.id))
                    .slice(0, 4)
                    .map((meta) => (
                      <SourceTile key={meta.id} id={meta.id} name={meta.name} small />
                    ))}
                </span>
              )}
              <span className={cn('text-xs', MUTED)}>
                {t(`${K}.otherAppsHint`, { count: others.length })}
              </span>
              <ChevronRight
                className={cn(
                  'size-4 text-text-tertiary transition-transform motion-reduce:transition-none mirror-rtl',
                  showOthers && 'rotate-90'
                )}
              />
            </button>
          </>
        )}
        {showOthers && others.map(sourceRow)}
      </OptionList>
      <p className={cn('flex max-w-[540px] items-center gap-1.5 pt-4 text-xs', MUTED)}>
        <Lock className="size-3 shrink-0" />
        {t(`${K}.detectedFootnote`, { device })}
      </p>
      <div className="flex flex-wrap items-center justify-center gap-4 pt-5">
        <ContinueButton
          label={t('onboardingWizard.keys.continue')}
          onClick={() => dispatch({ type: 'next' })}
        />
        {chosen.length > 0 ? (
          <span className={cn('text-[13px]', MUTED)}>
            {t(`${K}.sourcesSelected`, { count: chosen.length })}
          </span>
        ) : (
          <QuietLink underline={false} onClick={() => dispatch({ type: 'next' })}>
            {t(`${K}.skip`)}
          </QuietLink>
        )}
      </div>
    </>
  )
}
