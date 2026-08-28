'use client'

import { useCallback, useEffect, useState } from 'react'
import { HelpCircle, Loader2, MoreHorizontal, Plus } from '@/lib/icons'
import { useVault, useVaultList } from '@/hooks/use-vault'
import { useT } from '@memry/i18n/renderer'
import { LOCALE_DISPLAY_NAMES, SUPPORTED_LOCALES } from '@memry/i18n/shared'
import { type Locale } from '@memry/contracts/locale-api'
import { TrafficLights } from '@/components/traffic-lights'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from '@/components/ui/select'
import { cn } from '@/lib/utils'
import { trackTelemetry } from '@/lib/telemetry'

type Translate = (key: string) => string

function MemryMark({ className }: { className?: string }): React.JSX.Element {
  return (
    <svg
      className={className}
      viewBox="0 0 680 547"
      fill="currentColor"
      xmlns="http://www.w3.org/2000/svg"
      aria-hidden="true"
    >
      <path d="M652 345C667.464 345 680 357.536 680 373V519C680 534.464 667.464 547 652 547H28C12.536 547 3.70473e-07 534.464 0 519V373C1.99733e-06 357.536 12.536 345 28 345H652ZM510 0C603.169 0 678.727 75.3938 678.997 168.5H678.879L678.771 168.556L344.632 341.046C341.572 341.635 338.427 341.635 335.367 341.046L1.22949 168.556L1.12109 168.5H1.00293C1.27258 75.3938 76.8306 0 170 0C263.169 0 338.727 75.3938 338.997 168.5H341.003C341.273 75.3938 416.831 0 510 0Z" />
    </svg>
  )
}

const handleHelp = (): void => {
  window.open('https://docs.memrynote.com', '_blank', 'noopener,noreferrer')
}

export function VaultOnboarding(): React.JSX.Element {
  const { t, i18n } = useT('common')
  const { selectVault, switchVault, isLoading, error } = useVault()
  const { vaults, currentVault } = useVaultList()
  const [isChangingLocale, setIsChangingLocale] = useState(false)

  const recentVaults = vaults.slice(0, 8)
  const showSidebar = recentVaults.length > 0
  const activeLocale = getSupportedLocale(i18n.resolvedLanguage ?? i18n.language)

  useEffect(() => {
    void trackTelemetry('onboarding_started', { surface: 'onboarding', action: 'started' })
  }, [])

  const handlePick = async (): Promise<void> => {
    const result = await selectVault()
    if (result.success) {
      void trackTelemetry('onboarding_completed', {
        surface: 'onboarding',
        action: 'completed',
        result: 'success'
      })
    }
  }

  const handleOpenRecent = async (path: string): Promise<void> => {
    const result = await switchVault(path)
    if (result.success) {
      void trackTelemetry('onboarding_completed', {
        surface: 'onboarding',
        action: 'completed',
        result: 'success'
      })
    }
  }

  const handleLocaleChange = useCallback(
    async (locale: Locale): Promise<void> => {
      setIsChangingLocale(true)
      try {
        await window.api.locale.set(locale)
        await i18n.changeLanguage(locale)
      } catch {
        // Keep the picker usable if the preload bridge rejects the locale update.
      } finally {
        setIsChangingLocale(false)
      }
    },
    [i18n]
  )

  return (
    <div className="fixed inset-0 z-50 flex flex-col bg-background text-foreground antialiased font-sans">
      <div className="drag-region flex items-center h-9 px-3.5 shrink-0 bg-surface border-b border-border">
        <TrafficLights compact />
      </div>

      <div className="flex w-full grow shrink basis-0 min-h-0 bg-background">
        {showSidebar && (
          <RecentVaultSidebar
            t={t}
            recentVaults={recentVaults}
            currentVault={currentVault ?? null}
            isLoading={isLoading}
            onPick={() => void handlePick()}
            onOpenRecent={(path) => void handleOpenRecent(path)}
          />
        )}
        <PickerPanel
          t={t}
          isLoading={isLoading}
          error={error}
          onPick={() => void handlePick()}
          onHelp={handleHelp}
          activeLocale={activeLocale}
          isChangingLocale={isChangingLocale}
          onLocaleChange={(locale) => void handleLocaleChange(locale)}
        />
      </div>
    </div>
  )
}

function getSupportedLocale(language: string): Locale {
  const locale = language as Locale
  return SUPPORTED_LOCALES.includes(locale) ? locale : 'en'
}

interface RecentVault {
  name: string
  path: string
}

interface RecentVaultSidebarProps {
  t: Translate
  recentVaults: RecentVault[]
  currentVault: string | null
  isLoading: boolean
  onPick: () => void
  onOpenRecent: (path: string) => void
}

function RecentVaultSidebar({
  t,
  recentVaults,
  currentVault,
  isLoading,
  onPick,
  onOpenRecent
}: RecentVaultSidebarProps): React.JSX.Element {
  return (
    <aside className="flex flex-col w-64 shrink-0 h-full bg-surface border-e border-border">
      <header className="flex items-center justify-between shrink-0 pt-4 pb-2.5 ps-4 pe-4">
        <span className="font-heading font-semibold text-text-tertiary text-[11px] leading-[14px] uppercase tracking-[0.08em]">
          {t('phaseF.componentsVaultOnboarding.recentVaults')}
        </span>
        <button
          type="button"
          onClick={onPick}
          disabled={isLoading}
          aria-label={t('phaseF.componentsVaultOnboarding.addVault')}
          className="flex items-center justify-center size-5.5 shrink-0 rounded-md text-text-tertiary hover:bg-accent hover:text-foreground transition-colors disabled:opacity-50"
        >
          <Plus className="size-3.5" />
        </button>
      </header>

      <div className="flex flex-col grow shrink basis-0 py-1 px-2.5 overflow-y-auto gap-0.5">
        {recentVaults.map((vault) => {
          const isCurrent = currentVault === vault.path
          return (
            <button
              key={vault.path}
              type="button"
              onClick={() => onOpenRecent(vault.path)}
              disabled={isLoading}
              className={cn(
                'group flex items-center w-full text-start rounded-lg p-2 gap-2 transition-colors disabled:opacity-60',
                isCurrent ? 'bg-surface-active' : 'hover:bg-accent'
              )}
            >
              <span
                className={cn(
                  'flex items-center justify-center shrink-0 rounded-md size-6.5 transition-colors',
                  isCurrent
                    ? 'bg-accent-orange/15 text-accent-orange'
                    : 'bg-accent text-text-tertiary group-hover:text-foreground'
                )}
              >
                <MemryMark className="size-3.5" />
              </span>
              <span className="flex flex-col grow shrink basis-0 min-w-0 gap-0.5">
                <span className="font-heading font-medium text-foreground text-[13px] leading-4 truncate">
                  {vault.name}
                </span>
                <span className="text-text-tertiary text-[11px] leading-[14px] truncate">
                  {vault.path}
                </span>
              </span>
              <span className="flex items-center justify-center size-5.5 shrink-0 rounded-md text-text-tertiary opacity-0 group-hover:opacity-100 transition-opacity">
                <MoreHorizontal className="size-3.5" />
              </span>
            </button>
          )
        })}
      </div>
    </aside>
  )
}

interface PickerPanelProps {
  t: Translate
  isLoading: boolean
  error: string | null
  onPick: () => void
  onHelp: () => void
  activeLocale: Locale
  isChangingLocale: boolean
  onLocaleChange: (locale: Locale) => void
}

function PickerPanel({
  t,
  isLoading,
  error,
  onPick,
  onHelp,
  activeLocale,
  isChangingLocale,
  onLocaleChange
}: PickerPanelProps): React.JSX.Element {
  return (
    <main className="flex flex-col grow shrink basis-0 h-full bg-background">
      <PickerHeader t={t} />

      <div className="flex flex-col grow shrink basis-0 px-8">
        <ActionRow
          title={t('phaseF.componentsVaultOnboarding.createNewVault')}
          description={t('phaseF.componentsVaultOnboarding.createNewVaultDesc')}
          actionLabel={t('phaseF.componentsVaultOnboarding.create')}
          loading={isLoading}
          variant="primary"
          onClick={onPick}
        />
        <ActionRow
          title={t('phaseF.componentsVaultOnboarding.openExistingVault')}
          description={t('phaseF.componentsVaultOnboarding.openExistingVaultDesc')}
          actionLabel={t('phaseF.componentsVaultOnboarding.open')}
          loading={isLoading}
          variant="secondary"
          onClick={onPick}
        />
        {error && (
          <p role="alert" className="pt-3 text-xs leading-4 text-destructive">
            {error}
          </p>
        )}
      </div>

      <PickerFooter
        t={t}
        onHelp={onHelp}
        activeLocale={activeLocale}
        isChangingLocale={isChangingLocale}
        onLocaleChange={onLocaleChange}
      />
    </main>
  )
}

function PickerHeader({ t }: { t: Translate }): React.JSX.Element {
  return (
    <div className="flex flex-col items-center pt-8 pb-5 gap-3 px-8">
      <div className="flex items-center justify-center rounded-2xl shrink-0 size-14 bg-surface border border-border text-accent-orange">
        <MemryMark className="size-7" />
      </div>
      <div className="flex flex-col items-center gap-1">
        <h1 className="font-heading font-semibold text-text-bright text-2xl leading-7 tracking-[-0.01em]">
          {t('phaseF.componentsVaultOnboarding.brandName')}
        </h1>
        <p className="text-text-tertiary text-xs leading-4 tracking-[0.02em]">
          {t('phaseF.componentsVaultOnboarding.preRelease')}
        </p>
      </div>
    </div>
  )
}

function PickerFooter({
  t,
  onHelp,
  activeLocale,
  isChangingLocale,
  onLocaleChange
}: {
  t: Translate
  onHelp: () => void
  activeLocale: Locale
  isChangingLocale: boolean
  onLocaleChange: (locale: Locale) => void
}): React.JSX.Element {
  return (
    <div className="flex items-center justify-between pt-3 pb-4 gap-4 border-t border-border px-8">
      <button
        type="button"
        onClick={onHelp}
        className="flex items-center gap-2 text-text-tertiary hover:text-foreground transition-colors"
      >
        <HelpCircle className="size-4" />
        <span className="text-xs leading-4 tracking-[0.01em]">
          {t('phaseF.componentsVaultOnboarding.helpAndDocs')}
        </span>
      </button>
      <Select
        value={activeLocale}
        onValueChange={(value) => onLocaleChange(value as Locale)}
        disabled={isChangingLocale}
      >
        <SelectTrigger className="h-8 w-40 shrink-0 rounded-lg bg-surface text-xs leading-4 tracking-[0.005em] shadow-none">
          <SelectValue />
        </SelectTrigger>
        <SelectContent
          side="top"
          align="end"
          avoidCollisions={false}
          className="max-h-60 overflow-y-auto"
        >
          {SUPPORTED_LOCALES.map((locale) => (
            <SelectItem key={locale} value={locale}>
              {LOCALE_DISPLAY_NAMES[locale]}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  )
}

interface ActionRowProps {
  title: string
  description: string
  actionLabel: string
  loading: boolean
  variant: 'primary' | 'secondary'
  onClick: () => void
}

function ActionRow({
  title,
  description,
  actionLabel,
  loading,
  variant,
  onClick
}: ActionRowProps): React.JSX.Element {
  return (
    <div className="flex items-center py-3.5 gap-4 border-t border-border">
      <div className="flex flex-col grow shrink basis-0 min-w-0 gap-1">
        <p className="font-heading font-medium text-foreground text-sm leading-[18px]">{title}</p>
        <p className="text-text-tertiary text-xs leading-4">{description}</p>
      </div>
      <button
        type="button"
        onClick={onClick}
        disabled={loading}
        aria-label={title}
        className={cn(
          'flex items-center justify-center h-8 shrink-0 rounded-lg px-3.5 gap-1.5 text-[13px] leading-4 font-medium tracking-[0.005em] transition-colors disabled:opacity-60 disabled:cursor-not-allowed',
          variant === 'primary'
            ? 'bg-accent-orange text-white shadow-sm hover:brightness-105'
            : 'bg-transparent text-foreground border border-border hover:bg-accent'
        )}
      >
        {loading && <Loader2 className="size-3.5 animate-spin" />}
        <span>{actionLabel}</span>
      </button>
    </div>
  )
}
