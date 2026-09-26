'use client'

import { useCallback, useEffect, useState } from 'react'
import { Download, FolderOpen, HelpCircle, MoreHorizontal, Plus } from '@/lib/icons'
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
import { isMac } from '@/lib/shortcut-registry'
import { CreateVaultForm } from '@/components/onboarding/create-vault-form'
import { SyncVaultPanel } from '@/components/onboarding/sync-vault-panel'

type Translate = (key: string) => string

type OnboardingView = 'home' | 'create' | 'sync'

const trackCompleted = (): void => {
  void trackTelemetry('onboarding_completed', {
    surface: 'onboarding',
    action: 'completed',
    result: 'success'
  })
}

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
  const [view, setView] = useState<OnboardingView>('home')

  const recentVaults = vaults.slice(0, 8)
  const showSidebar = recentVaults.length > 0
  const activeLocale = getSupportedLocale(i18n.resolvedLanguage ?? i18n.language)

  useEffect(() => {
    void trackTelemetry('onboarding_started', { surface: 'onboarding', action: 'started' })
  }, [])

  // Without a path this shows the native folder picker ("Open folder as vault");
  // with one it adopts that folder (the create form's "open it instead").
  const handleOpenFolder = useCallback(
    async (path?: string): Promise<void> => {
      const result = await selectVault(path)
      if (result.success) trackCompleted()
    },
    [selectVault]
  )

  const handleOpenRecent = async (path: string): Promise<void> => {
    const result = await switchVault(path)
    if (result.success) trackCompleted()
  }

  // Home-view shortcuts mirror the hints shown on each action row.
  useEffect(() => {
    if (view !== 'home') return
    const onKeyDown = (event: KeyboardEvent): void => {
      const mod = isMac ? event.metaKey : event.ctrlKey
      if (!mod || event.shiftKey || event.altKey || isLoading) return
      const key = event.key.toLowerCase()
      if (key === 'n') setView('create')
      else if (key === 'o') void handleOpenFolder()
      else if (key === 'l') setView('sync')
      else return
      event.preventDefault()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [view, isLoading, handleOpenFolder])

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
            onPick={() => setView('create')}
            onOpenRecent={(path) => void handleOpenRecent(path)}
          />
        )}
        {view === 'create' ? (
          <main className="flex flex-col grow shrink basis-0 h-full bg-background">
            <CreateVaultForm
              onBack={() => setView('home')}
              onCreated={trackCompleted}
              onOpenExisting={(path) => void handleOpenFolder(path)}
            />
          </main>
        ) : view === 'sync' ? (
          <main className="flex flex-col grow shrink basis-0 h-full bg-background">
            <SyncVaultPanel
              onBack={() => setView('home')}
              onOpened={trackCompleted}
              onCreateVault={() => setView('create')}
            />
          </main>
        ) : (
          <PickerPanel
            t={t}
            isLoading={isLoading}
            error={error}
            onCreate={() => setView('create')}
            onOpenFolder={() => void handleOpenFolder()}
            onOpenFromSync={() => setView('sync')}
            onHelp={handleHelp}
            activeLocale={activeLocale}
            isChangingLocale={isChangingLocale}
            onLocaleChange={(locale) => void handleLocaleChange(locale)}
          />
        )}
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
  onCreate: () => void
  onOpenFolder: () => void
  onOpenFromSync: () => void
  onHelp: () => void
  activeLocale: Locale
  isChangingLocale: boolean
  onLocaleChange: (locale: Locale) => void
}

function PickerPanel({
  t,
  isLoading,
  error,
  onCreate,
  onOpenFolder,
  onOpenFromSync,
  onHelp,
  activeLocale,
  isChangingLocale,
  onLocaleChange
}: PickerPanelProps): React.JSX.Element {
  const mod = isMac ? '⌘' : 'Ctrl+'
  return (
    <main className="flex flex-col grow shrink basis-0 h-full bg-background">
      <div className="flex flex-col grow shrink basis-0 items-center justify-center px-8 gap-7">
        <PickerHeader t={t} />

        <div className="flex flex-col w-full max-w-[420px] gap-0.5">
          <ActionRow
            icon={<Plus />}
            title={t('phaseF.componentsVaultOnboarding.createNewVault')}
            description={t('phaseF.componentsVaultOnboarding.flow.createDesc')}
            shortcut={`${mod}N`}
            disabled={isLoading}
            onClick={onCreate}
          />
          <ActionRow
            icon={<FolderOpen />}
            title={t('phaseF.componentsVaultOnboarding.flow.openFolder')}
            description={t('phaseF.componentsVaultOnboarding.flow.openFolderDesc')}
            shortcut={`${mod}O`}
            disabled={isLoading}
            onClick={onOpenFolder}
          />
          <ActionRow
            icon={<Download />}
            title={t('phaseF.componentsVaultOnboarding.flow.openFromSync')}
            description={t('phaseF.componentsVaultOnboarding.flow.openFromSyncDesc')}
            shortcut={`${mod}L`}
            disabled={isLoading}
            onClick={onOpenFromSync}
          />
          {error && (
            <p role="alert" className="px-3 pt-3 text-xs leading-4 text-destructive">
              {error}
            </p>
          )}
        </div>
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
    <div className="flex flex-col items-center gap-3">
      <div className="flex items-center justify-center rounded-2xl shrink-0 size-14 bg-surface border border-border text-accent-orange">
        <MemryMark className="size-7" />
      </div>
      <div className="flex flex-col items-center gap-1">
        <h1 className="font-heading font-semibold text-text-bright text-2xl leading-7 tracking-[-0.01em]">
          {t('phaseF.componentsVaultOnboarding.brandName')}
        </h1>
        <p className="text-text-tertiary text-[13px] leading-[18px]">
          {t('phaseF.componentsVaultOnboarding.flow.tagline')}
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
  icon: React.ReactNode
  title: string
  description: string
  shortcut: string
  disabled: boolean
  onClick: () => void
}

function ActionRow({
  icon,
  title,
  description,
  shortcut,
  disabled,
  onClick
}: ActionRowProps): React.JSX.Element {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-label={title}
      aria-keyshortcuts={shortcut.replace('⌘', 'Meta+').replace('Ctrl+', 'Control+')}
      className="group flex items-center w-full gap-3 rounded-lg px-3 py-2.5 text-start transition-colors hover:bg-accent focus-visible:bg-accent focus-visible:outline-none disabled:opacity-60 disabled:cursor-not-allowed"
    >
      <span className="flex items-center justify-center size-8 shrink-0 rounded-lg border border-border bg-surface text-text-tertiary group-hover:text-foreground transition-colors [&_svg]:size-4">
        {icon}
      </span>
      <span className="flex flex-col grow shrink basis-0 min-w-0 gap-0.5">
        <span className="font-heading font-medium text-foreground text-[13px] leading-4">
          {title}
        </span>
        <span className="text-text-tertiary text-xs leading-4 truncate">{description}</span>
      </span>
      <kbd className="shrink-0 rounded-[5px] border border-border px-1.5 py-px font-sans text-[11px] leading-4 text-text-tertiary">
        {shortcut}
      </kbd>
    </button>
  )
}
