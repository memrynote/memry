'use client'

import { useState, useCallback, useEffect, useRef } from 'react'
import { Plus, Check, Loader2, X, Cloud, Trash2 } from '@/lib/icons'

import { Picker, PICKER_ROW_SELECTOR } from '@/components/ui/picker'
import {
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  useSidebar
} from '@/components/ui/sidebar'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle
} from '@/components/ui/alert-dialog'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import { useVault, useVaultList } from '@/hooks/use-vault'
import { useAccountVaults } from '@/hooks/use-account-vaults'
import { useSettingsModal } from '@/contexts/settings-modal-context'
import { useAuth } from '@/contexts/auth-context'
import { DownloadVaultDialog } from '@/components/download-vault-dialog'
import { extractErrorMessage } from '@/lib/ipc-error'
import { useVaultSwitcherOpenRequest } from '@/lib/vault-switcher-open'
import type { AccountVaultInfo, VaultInfo } from '../../../preload/index.d'
import { useT } from '@memry/i18n/renderer'

export function VaultSwitcher() {
  const { t: tPhaseF } = useT('common')
  const { isMobile, open: sidebarOpen, setOpen: setSidebarOpen, setOpenMobile } = useSidebar()
  const { status, isLoading, selectVault, switchVault } = useVault()
  const { vaults, removeVault } = useVaultList()
  const { open: openSettings } = useSettingsModal()
  const { state: authState } = useAuth()
  const { accountVaults, refresh: refreshAccountVaults } = useAccountVaults()
  const [vaultToRemove, setVaultToRemove] = useState<VaultInfo | null>(null)
  const [vaultToDownload, setVaultToDownload] = useState<AccountVaultInfo | null>(null)
  const [open, setOpen] = useState(false)
  const [vaultToDelete, setVaultToDelete] = useState<{ uuid: string; name: string } | null>(null)
  const [deleting, setDeleting] = useState(false)
  const [deleteError, setDeleteError] = useState<string | null>(null)

  /** Element focused when ⌘⇧O opened the switcher, so Escape can hand it back. */
  const restoreFocusRef = useRef<HTMLElement | null>(null)
  /** The shortcut may expand a collapsed sidebar; put it back when we are done. */
  const collapseSidebarOnCloseRef = useRef(false)

  const isAuthenticated = authState.status === 'authenticated'
  const remoteOnlyVaults = accountVaults.filter((vault) => !vault.localPath)

  const currentVaultName = status?.path
    ? status.path.split('/').pop() || 'Vault'
    : 'No Vault Selected'

  // ⌘⇧O (see `hooks/use-switch-vault-shortcut.ts`) opens this same picker rather
  // than a second vault list, so switching from the shortcut and from the
  // sidebar go through one code path.
  useVaultSwitcherOpenRequest(
    useCallback(() => {
      if (open) return
      const active = document.activeElement
      restoreFocusRef.current = active instanceof HTMLElement ? active : null

      if (isMobile) {
        setOpenMobile(true)
      } else if (!sidebarOpen) {
        // The sidebar is `collapsible="offcanvas"`: while closed the trigger is
        // parked off-screen and the popover would anchor to nothing.
        collapseSidebarOnCloseRef.current = true
        setSidebarOpen(true)
      }

      setOpen(true)
      if (isAuthenticated) void refreshAccountVaults()
    }, [
      open,
      isMobile,
      sidebarOpen,
      setOpenMobile,
      setSidebarOpen,
      isAuthenticated,
      refreshAccountVaults
    ])
  )

  // Runs for every close — Escape, an outside click, or picking a vault — because
  // the picker's own state can close it without going through `onOpenChange`.
  useEffect(() => {
    if (open) return

    if (collapseSidebarOnCloseRef.current) {
      collapseSidebarOnCloseRef.current = false
      setSidebarOpen(false)
    }

    const previous = restoreFocusRef.current
    restoreFocusRef.current = null
    if (previous?.isConnected) previous.focus()
  }, [open, setSidebarOpen])

  const handleSelectNewVault = useCallback(async () => {
    await selectVault()
  }, [selectVault])

  const handleSwitchVault = useCallback(
    async (path: string) => {
      setOpen(false)
      await switchVault(path)
    },
    [switchVault]
  )

  // Radix's own auto-focus takes the first row. Open on the active vault
  // instead, so ⌘⇧O lands where the user already is and Up/Down (handled in
  // `ui/picker/picker-content.tsx`) walks out from there.
  const handleOpenAutoFocus = useCallback((event: Event) => {
    const content = event.currentTarget
    if (!(content instanceof HTMLElement)) return

    const target =
      content.querySelector<HTMLElement>('[data-active-vault="true"]') ??
      content.querySelector<HTMLElement>(PICKER_ROW_SELECTOR)
    if (!target) return

    event.preventDefault()
    target.focus()
  }, [])

  const handleSignIn = useCallback(() => {
    setOpen(false)
    openSettings('account')
  }, [openSettings])

  const handleRemoveClick = (e: React.MouseEvent, vault: VaultInfo): void => {
    e.stopPropagation()
    setVaultToRemove(vault)
  }

  const handleConfirmRemove = (): void => {
    if (vaultToRemove) {
      void removeVault(vaultToRemove.path).then(() => {
        setVaultToRemove(null)
      })
    }
  }

  const handleDeleteClick = (e: React.MouseEvent, uuid: string, name: string): void => {
    e.stopPropagation()
    setDeleteError(null)
    setVaultToDelete({ uuid, name })
  }

  const handleConfirmDelete = useCallback(async () => {
    if (!vaultToDelete) return
    setDeleting(true)
    try {
      await window.api.vault.deleteFromAccount(vaultToDelete.uuid)
      setVaultToDelete(null)
      await refreshAccountVaults()
    } catch (err) {
      setDeleteError(
        extractErrorMessage(err, tPhaseF('phaseF.componentsVaultSwitcher.deleteVaultFailed'))
      )
    } finally {
      setDeleting(false)
    }
  }, [vaultToDelete, refreshAccountVaults, tPhaseF])

  return (
    <SidebarMenu>
      <SidebarMenuItem>
        <Picker
          value={null}
          onValueChange={(action) => {
            if (action === 'open-vault') void handleSelectNewVault()
          }}
          open={open}
          onOpenChange={(nextOpen) => {
            setOpen(nextOpen)
            if (nextOpen && isAuthenticated) void refreshAccountVaults()
          }}
        >
          <Picker.Trigger asChild>
            <SidebarMenuButton
              size="default"
              className="rounded-[5px] gap-2 h-6 px-2 hover:bg-sidebar-accent/50 data-[state=open]:bg-sidebar-accent data-[state=open]:text-sidebar-accent-foreground group-data-[collapsible=icon]:justify-center"
            >
              <div className="flex aspect-square size-[16px] shrink-0 items-center justify-center rounded-[4px] bg-sidebar-terracotta text-white">
                {isLoading ? (
                  <Loader2 className="size-3 animate-spin" />
                ) : (
                  <span className="text-white font-bold text-[8px] leading-none">
                    {currentVaultName.charAt(0).toUpperCase()}
                  </span>
                )}
              </div>
              <span className="truncate text-[12px] font-semibold text-sidebar-primary tracking-[-0.01em] leading-none group-data-[collapsible=icon]:hidden">
                {currentVaultName}
              </span>
            </SidebarMenuButton>
          </Picker.Trigger>
          <Picker.Content
            width="auto"
            onOpenAutoFocus={handleOpenAutoFocus}
            onCloseAutoFocus={(e) => e.preventDefault()}
            className="min-w-56"
            align="start"
            side={isMobile ? 'bottom' : 'right'}
            sideOffset={8}
          >
            <Picker.List>
              {vaults.length > 0 ? (
                vaults.map((vault) => {
                  const isActive = status?.path === vault.path
                  return (
                    <button
                      key={vault.path}
                      type="button"
                      onClick={() => !isActive && void handleSwitchVault(vault.path)}
                      data-active-vault={isActive ? 'true' : undefined}
                      className={cn(
                        'group/vault flex w-full items-center gap-2.5 rounded-[5px] px-2 py-1.5 transition-colors',
                        // Arrow keys walk these rows (see `picker-content.tsx`).
                        // The tinted row IS the cursor — hover and keyboard
                        // focus share it, and the active vault is marked by its
                        // check and weight instead, so exactly one row ever
                        // reads as highlighted. A ring here would collide with
                        // the popover edge and the row below it.
                        'focus:outline-none focus-visible:bg-accent',
                        isActive ? 'cursor-default' : 'hover:bg-accent cursor-pointer'
                      )}
                    >
                      <Check
                        className={cn(
                          'size-3.5 shrink-0',
                          isActive ? 'text-sidebar-terracotta opacity-100' : 'opacity-0'
                        )}
                      />
                      <span
                        className={cn(
                          'flex-1 truncate text-start',
                          isActive ? 'font-medium' : 'text-muted-foreground'
                        )}
                      >
                        {vault.name}
                      </span>
                      {!isActive && (
                        <span className="flex items-center gap-0.5 opacity-0 group-hover/vault:opacity-100 transition-all">
                          <span
                            role="button"
                            tabIndex={0}
                            onClick={(e) => handleRemoveClick(e, vault)}
                            onKeyDown={(e) =>
                              e.key === 'Enter' &&
                              handleRemoveClick(e as unknown as React.MouseEvent, vault)
                            }
                            className="size-5 flex items-center justify-center rounded hover:bg-accent"
                            aria-label={`Remove ${vault.name} from list`}
                          >
                            <X className="size-3 text-muted-foreground" />
                          </span>
                          {vault.vaultUuid && isAuthenticated && (
                            <span
                              role="button"
                              tabIndex={0}
                              onClick={(e) => handleDeleteClick(e, vault.vaultUuid!, vault.name)}
                              onKeyDown={(e) =>
                                e.key === 'Enter' &&
                                handleDeleteClick(
                                  e as unknown as React.MouseEvent,
                                  vault.vaultUuid!,
                                  vault.name
                                )
                              }
                              className="size-5 flex items-center justify-center rounded hover:bg-destructive/10"
                              aria-label={`Delete ${vault.name} from account`}
                            >
                              <Trash2 className="size-3 text-muted-foreground" />
                            </span>
                          )}
                        </span>
                      )}
                    </button>
                  )
                })
              ) : (
                <Picker.Empty message={tPhaseF('phaseF.componentsVaultSwitcher.noVaultsYet')} />
              )}

              {isAuthenticated && remoteOnlyVaults.length > 0 && (
                <>
                  <Picker.Separator />
                  <div className="px-2 py-1 text-[10px] uppercase tracking-wide text-muted-foreground/60">
                    {tPhaseF('phaseF.componentsVaultSwitcher.inYourAccount')}
                  </div>
                  {remoteOnlyVaults.map((vault) => (
                    <button
                      key={vault.vaultUuid}
                      type="button"
                      onClick={() => {
                        setOpen(false)
                        setVaultToDownload(vault)
                      }}
                      className="flex w-full items-center gap-2.5 rounded-[5px] px-2 py-1.5 hover:bg-accent transition-colors cursor-pointer focus:outline-none focus-visible:bg-accent"
                    >
                      <Cloud className="size-3.5 shrink-0 text-muted-foreground" />
                      <span className="flex-1 truncate text-start text-muted-foreground">
                        {vault.name ?? tPhaseF('phaseF.componentsVaultSwitcher.untitledVault')}
                      </span>
                      <span className="text-[10px] text-muted-foreground/60">
                        {tPhaseF('phaseF.componentsVaultSwitcher.itemsCount', {
                          count: vault.itemCount
                        })}
                      </span>
                      <span
                        role="button"
                        tabIndex={0}
                        onClick={(e) =>
                          handleDeleteClick(
                            e,
                            vault.vaultUuid,
                            vault.name ?? tPhaseF('phaseF.componentsVaultSwitcher.untitledVault')
                          )
                        }
                        onKeyDown={(e) =>
                          e.key === 'Enter' &&
                          handleDeleteClick(
                            e as unknown as React.MouseEvent,
                            vault.vaultUuid,
                            vault.name ?? tPhaseF('phaseF.componentsVaultSwitcher.untitledVault')
                          )
                        }
                        className="size-5 flex items-center justify-center rounded hover:bg-destructive/10"
                        aria-label={`Delete ${vault.name ?? 'vault'} from account`}
                      >
                        <Trash2 className="size-3 text-muted-foreground" />
                      </span>
                    </button>
                  ))}
                </>
              )}

              <Picker.Separator />

              <Picker.Item
                value="open-vault"
                label={tPhaseF('phaseF.componentsVaultSwitcher.openVault')}
                icon={<Plus className="size-3.5" />}
              />

              {!isAuthenticated && (
                <>
                  <Picker.Separator />
                  <button
                    type="button"
                    onClick={handleSignIn}
                    className="flex w-full items-center gap-2.5 rounded-[5px] px-2 py-1.5 hover:bg-accent transition-colors cursor-pointer focus:outline-none focus-visible:bg-accent"
                  >
                    <Cloud className="size-3.5 text-sidebar-terracotta" />
                    <span className="text-sidebar-terracotta font-medium">
                      {tPhaseF('phaseF.componentsVaultSwitcher.signInToSync')}
                    </span>
                  </button>
                </>
              )}
            </Picker.List>
          </Picker.Content>
        </Picker>
      </SidebarMenuItem>

      <DownloadVaultDialog vault={vaultToDownload} onClose={() => setVaultToDownload(null)} />

      <AlertDialog open={!!vaultToRemove} onOpenChange={(o) => !o && setVaultToRemove(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {tPhaseF('phaseF.componentsVaultSwitcher.removeVaultTitle', {
                name: vaultToRemove?.name ?? ''
              })}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {tPhaseF(
                'phaseF.componentsVaultSwitcher.thisVaultWillBeRemovedFromTheAppButYourFilesWillRemainOn'
              )}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <Button variant="outline" onClick={() => setVaultToRemove(null)}>
              {tPhaseF('phaseF.componentsVaultSwitcher.cancel')}
            </Button>
            <Button variant="destructive" onClick={handleConfirmRemove}>
              {tPhaseF('phaseF.componentsVaultSwitcher.remove2')}
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog
        open={!!vaultToDelete}
        onOpenChange={(o) => {
          if (!o) {
            setVaultToDelete(null)
            setDeleteError(null)
          }
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {tPhaseF('phaseF.componentsVaultSwitcher.deleteVaultTitle', {
                name: vaultToDelete?.name ?? ''
              })}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {tPhaseF('phaseF.componentsVaultSwitcher.deleteVaultBody')}
            </AlertDialogDescription>
          </AlertDialogHeader>
          {deleteError && <p className="text-xs/4 text-destructive px-1">{deleteError}</p>}
          <AlertDialogFooter>
            <AlertDialogCancel disabled={deleting}>
              {tPhaseF('phaseF.componentsVaultSwitcher.cancel')}
            </AlertDialogCancel>
            <AlertDialogAction
              onClick={(e) => {
                e.preventDefault()
                void handleConfirmDelete()
              }}
              disabled={deleting}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              {tPhaseF('phaseF.componentsVaultSwitcher.deleteVaultConfirm')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </SidebarMenu>
  )
}
