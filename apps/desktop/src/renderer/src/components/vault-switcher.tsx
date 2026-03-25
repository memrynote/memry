'use client'

import { useState, useCallback } from 'react'
import { Plus, Check, Loader2, Settings, X, LogOut, Cloud } from '@/lib/icons'

import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'
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
import { useVault, useVaultList } from '@/hooks/use-vault'
import { useSettingsModal } from '@/contexts/settings-modal-context'
import { useAuth } from '@/contexts/auth-context'
import type { VaultInfo } from '../../../preload/index.d'

export function VaultSwitcher() {
  const { isMobile } = useSidebar()
  const { status, isLoading, selectVault, switchVault } = useVault()
  const { vaults, removeVault } = useVaultList()
  const { open: openSettings } = useSettingsModal()
  const { state: authState, logout } = useAuth()
  const [vaultToRemove, setVaultToRemove] = useState<VaultInfo | null>(null)

  const isAuthenticated = authState.status === 'authenticated'

  const currentVaultName = status?.path
    ? status.path.split('/').pop() || 'Vault'
    : 'No Vault Selected'

  const handleSelectNewVault = useCallback(async () => {
    await selectVault()
  }, [selectVault])

  const handleSwitchVault = useCallback(
    async (path: string) => {
      await switchVault(path)
    },
    [switchVault]
  )

  const handleOpenSettings = useCallback(() => {
    openSettings()
  }, [openSettings])

  const handleSignIn = useCallback(() => {
    openSettings('account')
  }, [openSettings])

  const handleLogout = useCallback(async () => {
    await logout()
  }, [logout])

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
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
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
          </DropdownMenuTrigger>
          <DropdownMenuContent
            onCloseAutoFocus={(e) => e.preventDefault()}
            className="min-w-56 rounded-lg p-1 shadow-lg"
            align="start"
            side={isMobile ? 'bottom' : 'right'}
            sideOffset={8}
          >
            {/* Email context (signed in only) */}
            {isAuthenticated && authState.email && (
              <>
                <div className="px-2.5 py-2 text-[11px] text-muted-foreground/60">
                  {authState.email}
                </div>
                <DropdownMenuSeparator />
              </>
            )}

            {/* Vault list */}
            {vaults.length > 0 ? (
              vaults.map((vault) => {
                const isActive = status?.path === vault.path
                return (
                  <DropdownMenuItem
                    key={vault.path}
                    onClick={() => !isActive && handleSwitchVault(vault.path)}
                    className={`group/vault gap-2.5 rounded-[5px] cursor-pointer ${isActive ? 'bg-accent' : ''}`}
                  >
                    <Check
                      className={`size-3.5 shrink-0 ${isActive ? 'text-sidebar-terracotta opacity-100' : 'opacity-0'}`}
                    />
                    <span
                      className={`flex-1 truncate text-[13px] ${isActive ? 'font-medium' : 'text-muted-foreground'}`}
                    >
                      {vault.name}
                    </span>
                    {!isActive && (
                      <button
                        onClick={(e) => handleRemoveClick(e, vault)}
                        className="size-5 flex items-center justify-center rounded opacity-0 group-hover/vault:opacity-100 hover:bg-accent transition-all"
                        aria-label={`Remove ${vault.name} from list`}
                      >
                        <X className="size-3 text-muted-foreground" />
                      </button>
                    )}
                  </DropdownMenuItem>
                )
              })
            ) : (
              <div className="px-2.5 py-2 text-[13px] text-muted-foreground text-center">
                No vaults yet
              </div>
            )}

            <DropdownMenuSeparator />

            {/* Actions */}
            <DropdownMenuItem
              onClick={handleSelectNewVault}
              className="gap-2.5 rounded-[5px] cursor-pointer"
            >
              <Plus className="size-3.5 text-muted-foreground" />
              <span className="text-muted-foreground text-[13px]">Open vault</span>
            </DropdownMenuItem>
            <DropdownMenuItem
              onClick={handleOpenSettings}
              className="gap-2.5 rounded-[5px] cursor-pointer"
            >
              <Settings className="size-3.5 text-muted-foreground" />
              <span className="text-muted-foreground text-[13px]">Settings</span>
            </DropdownMenuItem>

            <DropdownMenuSeparator />

            {/* Auth action */}
            {isAuthenticated ? (
              <DropdownMenuItem
                onClick={() => void handleLogout()}
                className="gap-2.5 rounded-[5px] cursor-pointer"
              >
                <LogOut className="size-3.5 text-muted-foreground" />
                <span className="text-muted-foreground text-[13px]">Log out</span>
              </DropdownMenuItem>
            ) : (
              <DropdownMenuItem
                onClick={handleSignIn}
                className="gap-2.5 rounded-[5px] cursor-pointer"
              >
                <Cloud className="size-3.5 text-sidebar-terracotta" />
                <span className="text-sidebar-terracotta font-medium text-[13px]">
                  Sign in to sync
                </span>
              </DropdownMenuItem>
            )}
          </DropdownMenuContent>
        </DropdownMenu>
      </SidebarMenuItem>

      {/* Remove Vault Confirmation Dialog */}
      <AlertDialog open={!!vaultToRemove} onOpenChange={(open) => !open && setVaultToRemove(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              Remove &ldquo;{vaultToRemove?.name}&rdquo; from list?
            </AlertDialogTitle>
            <AlertDialogDescription>
              This vault will be removed from the app, but your files will remain on disk. You can
              always re-add it later.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <Button variant="outline" onClick={() => setVaultToRemove(null)}>
              Cancel
            </Button>
            <Button variant="destructive" onClick={handleConfirmRemove}>
              Remove
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </SidebarMenu>
  )
}
