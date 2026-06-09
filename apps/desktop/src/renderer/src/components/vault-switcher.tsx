'use client'

import { useState, useCallback } from 'react'
import { Plus, Check, Loader2, X, Cloud } from '@/lib/icons'

import { Picker } from '@/components/ui/picker'
import {
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  useSidebar
} from '@/components/ui/sidebar'
import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle
} from '@/components/ui/alert-dialog'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import { useVault, useVaultList } from '@/hooks/use-vault'
import { useSettingsModal } from '@/contexts/settings-modal-context'
import { useAuth } from '@/contexts/auth-context'
import type { VaultInfo } from '../../../preload/index.d'
import { useT } from '@memry/i18n/renderer'

export function VaultSwitcher() {
  const { t: tPhaseF } = useT('common')
  const { isMobile } = useSidebar()
  const { status, isLoading, selectVault, switchVault } = useVault()
  const { vaults, removeVault } = useVaultList()
  const { open: openSettings } = useSettingsModal()
  const { state: authState } = useAuth()
  const [vaultToRemove, setVaultToRemove] = useState<VaultInfo | null>(null)
  const [open, setOpen] = useState(false)

  const isAuthenticated = authState.status === 'authenticated'

  const currentVaultName = status?.path
    ? status.path.split('/').pop() || 'Vault'
    : 'No Vault Selected'

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

  return (
    <SidebarMenu>
      <SidebarMenuItem>
        <Picker
          value={null}
          onValueChange={(action) => {
            if (action === 'open-vault') void handleSelectNewVault()
          }}
          open={open}
          onOpenChange={setOpen}
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
                      className={cn(
                        'group/vault flex w-full items-center gap-2.5 rounded-[5px] px-2 py-1.5 transition-colors',
                        isActive ? 'bg-accent' : 'hover:bg-accent cursor-pointer'
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
                        <span
                          role="button"
                          tabIndex={0}
                          onClick={(e) => handleRemoveClick(e, vault)}
                          onKeyDown={(e) =>
                            e.key === 'Enter' &&
                            handleRemoveClick(e as unknown as React.MouseEvent, vault)
                          }
                          className="size-5 flex items-center justify-center rounded opacity-0 group-hover/vault:opacity-100 hover:bg-accent transition-all"
                          aria-label={`Remove ${vault.name} from list`}
                        >
                          <X className="size-3 text-muted-foreground" />
                        </span>
                      )}
                    </button>
                  )
                })
              ) : (
                <Picker.Empty message={tPhaseF('phaseF.componentsVaultSwitcher.noVaultsYet')} />
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
                    className="flex w-full items-center gap-2.5 rounded-[5px] px-2 py-1.5 hover:bg-accent transition-colors cursor-pointer"
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

      <AlertDialog open={!!vaultToRemove} onOpenChange={(o) => !o && setVaultToRemove(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {tPhaseF('phaseF.componentsVaultSwitcher.remove')}
              {vaultToRemove?.name}&{tPhaseF('phaseF.componentsVaultSwitcher.rdquoFromList')}
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
    </SidebarMenu>
  )
}
