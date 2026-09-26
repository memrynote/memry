import React from 'react'
import { Cloud, CloudOff, RefreshCw, Settings } from '@/lib/icons'
import type { AppIcon } from '@/lib/icons'
import { cn } from '@/lib/utils'
import { createLogger } from '@/lib/logger'
import { useSyncStatus } from '@/hooks/use-sync-status'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { Button } from '@/components/ui/button'
import { Separator } from '@/components/ui/separator'
import { SidebarMenuButton } from '@/components/ui/sidebar'
import { DockButton, type DockBadgeTone } from '@/components/sidebar/footer-dock'
import { useT } from '@memry/i18n/renderer'
import { useSyncOptional } from '@/contexts/sync-context'
import type { VaultBindingState } from '@memry/contracts/ipc-sync-ops'

const log = createLogger('SyncStatus')

/**
 * What the popover offers an account with no active sync plan: nothing here is
 * retryable and nothing failed, so it sells the upgrade rather than showing a
 * Retry whose only outcome is another 402 (#2201).
 */
function UnpaidSyncPanel({ onOpenSettings }: { onOpenSettings: () => void }): React.JSX.Element {
  const { t } = useT('settings')

  return (
    <div className="space-y-2 px-3 py-2.5">
      <p className="text-muted-foreground text-xs">{t('account.sync.upsell.description')}</p>
      <Button size="sm" onClick={onOpenSettings} className="h-7 w-full text-xs">
        {t('account.billing.actions.unlockSync')}
      </Button>
    </div>
  )
}

type HeldBindingStatus = Extract<
  VaultBindingState['status'],
  'local-only' | 'foreign' | 'needs-decision'
>

function isHeldBinding(status: VaultBindingState['status']): status is HeldBindingStatus {
  return status === 'local-only' || status === 'foreign' || status === 'needs-decision'
}

/**
 * The open vault does not sync with this account, by the user's choice or
 * because it is someone else's. Retry and Pause mean nothing here, so the
 * popover explains why and offers the one action that applies.
 */
function VaultBindingPanel({ status }: { status: HeldBindingStatus }): React.JSX.Element {
  const { t } = useT('settings')
  const sync = useSyncOptional()

  const message =
    status === 'local-only'
      ? t('vault.binding.status.localOnly')
      : status === 'foreign'
        ? t('vault.binding.status.foreign')
        : t('vault.binding.status.needsDecision')

  return (
    <div className="space-y-2 px-3 py-2.5">
      <p className="text-muted-foreground text-xs">{message}</p>
      {status === 'local-only' && (
        <Button
          size="sm"
          className="h-7 w-full text-xs"
          onClick={() => void sync?.resolveVaultBinding('sync')}
        >
          {t('vault.binding.status.startSync')}
        </Button>
      )}
      {status === 'needs-decision' && (
        <Button
          size="sm"
          className="h-7 w-full text-xs"
          onClick={() => sync?.openVaultBindingPrompt()}
        >
          {t('vault.binding.status.choose')}
        </Button>
      )}
    </div>
  )
}

/**
 * Footer-dock glyph: one cloud whose corner dot carries the state, so the dock
 * never flips between five unrelated icons. Syncing swaps to the spinning arrows
 * and a plan-less or unknown account shows the struck cloud with no dot.
 */
function dockGlyph(
  status: string,
  hasIssues: boolean
): { Icon: AppIcon; badge: DockBadgeTone | null; spin: boolean } {
  if (hasIssues || status === 'error') return { Icon: Cloud, badge: 'destructive', spin: false }
  switch (status) {
    case 'syncing':
      return { Icon: RefreshCw, badge: null, spin: true }
    case 'idle':
      return { Icon: Cloud, badge: 'success', spin: false }
    case 'offline':
    case 'paused':
      return { Icon: Cloud, badge: 'warning', spin: false }
    case 'local_only':
      return { Icon: CloudOff, badge: null, spin: false }
    default:
      return { Icon: Cloud, badge: null, spin: false }
  }
}

interface SyncStatusProps {
  onOpenSettings: () => void
  /** Renders the trigger as the sidebar footer-dock button. */
  iconOnly?: boolean
}

export function SyncStatus({ onOpenSettings, iconOnly }: SyncStatusProps): React.JSX.Element {
  const { t: tPhaseF } = useT('settings')
  const {
    status,
    label,
    lastSyncLabel,
    dotColor,
    IconComponent,
    isAnimating,
    hasIssues,
    pendingCount,
    localOnlyCount,
    conflicts,
    error,
    sessionExpired,
    clockSkewDetected,
    initialSyncProgress,
    syncActivity,
    triggerSync,
    pause,
    resume,
    clearError,
    clearConflicts
  } = useSyncStatus()

  const isSyncing = status === 'syncing'
  const isOffline = status === 'offline'
  // No plan, no sync runtime — nothing here is retryable and nothing failed.
  // The popover sells the upgrade instead of showing a dead Retry (#2201).
  const isLocalOnly = status === 'local_only'
  const bindingStatus = useSyncOptional()?.vaultBinding.status ?? 'bound'
  const heldBinding = isHeldBinding(bindingStatus) ? bindingStatus : null
  const glyph = heldBinding
    ? { Icon: CloudOff, badge: null, spin: false }
    : dockGlyph(status, hasIssues)

  const handleSync = async (): Promise<void> => {
    try {
      await triggerSync()
    } catch (err) {
      log.error('Manual sync trigger failed', err)
    }
  }

  const handlePauseResume = async (): Promise<void> => {
    try {
      if (status === 'paused') {
        await resume()
      } else {
        await pause()
      }
    } catch (err) {
      log.error('Pause/resume failed', err)
    }
  }

  return (
    <Popover>
      <PopoverTrigger asChild>
        {iconOnly ? (
          <DockButton
            data-tour="sync-status"
            aria-label={`Sync status: ${label}`}
            title={label}
            badge={glyph.badge}
          >
            <glyph.Icon
              aria-hidden="true"
              className={cn(
                glyph.spin && 'animate-spin text-[var(--tint)] motion-reduce:animate-none'
              )}
            />
          </DockButton>
        ) : (
          <SidebarMenuButton
            size="sm"
            data-tour="sync-status"
            tooltip={label}
            aria-label={`Sync status: ${label}`}
            className={cn('text-muted-foreground', hasIssues && 'text-destructive')}
          >
            <IconComponent
              className={cn('size-4', isAnimating && 'animate-spin')}
              aria-hidden="true"
            />
            <span className="text-xs">{label}</span>
          </SidebarMenuButton>
        )}
      </PopoverTrigger>

      <PopoverContent side="top" align="start" className="w-72 p-0">
        {/* Status header */}
        <output className="flex items-center gap-2 px-3 py-2.5" aria-live="polite">
          <span className={cn('size-2 shrink-0 rounded-full', dotColor)} aria-hidden="true" />
          <div className="min-w-0 flex-1">
            <p className="text-sm font-medium">{label}</p>
            <p className="text-muted-foreground text-xs">
              {tPhaseF('phaseF.componentsSyncSyncStatus.lastSynced')}
              {lastSyncLabel}
            </p>
          </div>
        </output>

        {/* Info rows */}
        {(pendingCount > 0 ||
          localOnlyCount > 0 ||
          conflicts.length > 0 ||
          clockSkewDetected ||
          (isSyncing && initialSyncProgress) ||
          (isSyncing && (syncActivity.pushCount > 0 || syncActivity.pullCount > 0))) && (
          <>
            <Separator />
            <div className="space-y-1 px-3 py-2">
              {isSyncing && (syncActivity.pushCount > 0 || syncActivity.pullCount > 0) && (
                <p className="text-muted-foreground text-xs">
                  {[
                    syncActivity.pushCount > 0 && `${syncActivity.pushCount} pushed`,
                    syncActivity.pullCount > 0 && `${syncActivity.pullCount} pulled`
                  ]
                    .filter(Boolean)
                    .join(' · ')}
                </p>
              )}
              {pendingCount > 0 && (
                <p className="text-muted-foreground text-xs">
                  {pendingCount} {pendingCount === 1 ? 'change' : 'changes'}{' '}
                  {tPhaseF('phaseF.componentsSyncSyncStatus.pending')}
                </p>
              )}
              {localOnlyCount > 0 && (
                <p className="text-muted-foreground text-xs">
                  {localOnlyCount} {tPhaseF('phaseF.componentsSyncSyncStatus.localOnly')}{' '}
                  {localOnlyCount === 1 ? 'note' : 'notes'}
                </p>
              )}
              {conflicts.length > 0 && (
                <div className="flex items-center gap-2">
                  <p className="text-xs text-yellow-600 dark:text-yellow-400">
                    {conflicts.length} {conflicts.length === 1 ? 'conflict' : 'conflicts'}{' '}
                    {tPhaseF('phaseF.componentsSyncSyncStatus.detected')}
                  </p>
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={clearConflicts}
                    className="ms-auto h-5 px-1.5 text-xs"
                  >
                    {tPhaseF('phaseF.componentsSyncSyncStatus.dismissConflicts')}
                  </Button>
                </div>
              )}
              {clockSkewDetected && (
                <p className="text-xs text-yellow-600 dark:text-yellow-400">
                  {tPhaseF('phaseF.componentsSyncSyncStatus.clockSkewDetected')}
                </p>
              )}
              {isSyncing && initialSyncProgress && (
                <p className="text-muted-foreground text-xs">
                  {initialSyncProgress.current}/{initialSyncProgress.total}{' '}
                  {tPhaseF('phaseF.componentsSyncSyncStatus.items')}
                </p>
              )}
              {isOffline && pendingCount > 0 && (
                <p className="text-muted-foreground text-xs">
                  {tPhaseF('phaseF.componentsSyncSyncStatus.willSyncWhenBackOnline')}
                </p>
              )}
            </div>
          </>
        )}

        {/* Error display */}
        {error && (
          <>
            <Separator />
            <div className="bg-destructive/10 px-3 py-2" role="alert">
              <p className="text-destructive text-xs">
                {sessionExpired ? 'Session expired — sign in again' : error}
              </p>
            </div>
          </>
        )}

        {/* Actions, or the upgrade path when there is no plan to act on */}
        <Separator />
        {heldBinding ? (
          <VaultBindingPanel status={heldBinding} />
        ) : isLocalOnly ? (
          <UnpaidSyncPanel onOpenSettings={onOpenSettings} />
        ) : (
          <div className="flex items-center gap-1 px-2 py-1.5">
            <Button
              variant="ghost"
              size="sm"
              onClick={
                error
                  ? () => {
                      clearError()
                      void handleSync()
                    }
                  : () => void handleSync()
              }
              disabled={isSyncing || isOffline}
              className="h-7 text-xs"
            >
              {error ? 'Retry' : 'Sync Now'}
            </Button>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => void handlePauseResume()}
              disabled={isOffline}
              className="h-7 text-xs"
            >
              {status === 'paused' ? 'Resume' : 'Pause'}
            </Button>
            <div className="flex-1" />
            <Button
              variant="ghost"
              size="icon-sm"
              onClick={onOpenSettings}
              className="size-7"
              aria-label={tPhaseF('phaseF.componentsSyncSyncStatus.openSyncSettings')}
            >
              <Settings className="size-3.5" aria-hidden="true" />
            </Button>
          </div>
        )}
      </PopoverContent>
    </Popover>
  )
}
