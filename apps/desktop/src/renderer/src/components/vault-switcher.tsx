'use client'

import { useState } from 'react'
import {
  ChevronsUpDown,
  Plus,
  Check,
  FolderOpen,
  HardDrive,
  Loader2,
  LayoutTemplate,
  Settings,
  X
} from 'lucide-react'

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
import { useTabActions } from '@/contexts/tabs'
import type { VaultInfo } from '../../../preload/index.d'

export function VaultSwitcher() {
  const { isMobile } = useSidebar()
  const { status, isLoading, selectVault, switchVault } = useVault()
  const { vaults, removeVault } = useVaultList()
  const { openTab } = useTabActions()
  const [vaultToRemove, setVaultToRemove] = useState<VaultInfo | null>(null)

  const currentVaultName = status?.path
    ? status.path.split('/').pop() || 'Vault'
    : 'No Vault Selected'

  const handleSelectNewVault = async () => {
    await selectVault()
  }

  const handleSwitchVault = async (path: string) => {
    await switchVault(path)
  }

  const handleOpenTemplates = () => {
    openTab({
      type: 'templates',
      title: 'Templates',
      icon: 'layout-template',
      path: '/templates',
      isPinned: false,
      isModified: false,
      isPreview: false,
      isDeleted: false
    })
  }

  const handleOpenSettings = () => {
    openTab({
      type: 'settings',
      title: 'Settings',
      icon: 'settings',
      path: '/settings',
      isPinned: false,
      isModified: false,
      isPreview: false,
      isDeleted: false
    })
  }

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
              className="rounded-md gap-2 h-auto py-1.5 px-2 hover:bg-sidebar-accent/50 data-[state=open]:bg-sidebar-accent data-[state=open]:text-sidebar-accent-foreground group-data-[collapsible=icon]:justify-center"
            >
              <div className="flex aspect-square size-6 shrink-0 items-center justify-center rounded-md bg-sidebar-terracotta text-white">
                {isLoading ? (
                  <Loader2 className="size-3 animate-spin" />
                ) : (
                  <HardDrive className="size-3" />
                )}
              </div>
              <div className="grid flex-1 text-left leading-tight group-data-[collapsible=icon]:hidden">
                <span className="truncate text-[13px] font-semibold text-sidebar-primary tracking-[-0.01em] leading-4">
                  {currentVaultName}
                </span>
                {status?.isIndexing && (
                  <span className="text-xs text-sidebar-muted">
                    Indexing... {status.indexProgress}%
                  </span>
                )}
              </div>
              <ChevronsUpDown className="ml-auto size-4 text-sidebar-muted opacity-0 group-hover:opacity-100 transition-opacity group-data-[collapsible=icon]:hidden" />
            </SidebarMenuButton>
          </DropdownMenuTrigger>
          <DropdownMenuContent
            className="w-[--radix-dropdown-menu-trigger-width] min-w-64 rounded-xl p-2 shadow-lg"
            align="start"
            side={isMobile ? 'bottom' : 'right'}
            sideOffset={8}
          >
            {/* Vault list header */}
            <div className="px-2 py-1.5 text-xs font-medium text-muted-foreground uppercase tracking-wider">
              Vaults
            </div>

            {/* Current vault and other vaults */}
            {vaults.length > 0 ? (
              vaults.map((vault) => {
                const isActive = status?.path === vault.path
                return (
                  <DropdownMenuItem
                    key={vault.path}
                    onClick={() => !isActive && handleSwitchVault(vault.path)}
                    className="group/vault rounded-lg cursor-pointer hover:bg-accent focus:bg-accent transition-colors"
                  >
                    <div className="flex size-7 items-center justify-center rounded-md border border-border bg-card">
                      <FolderOpen className="size-4 shrink-0 text-sidebar-terracotta" />
                    </div>
                    <div className="flex-1 min-w-0">
                      <span className="font-medium text-foreground block truncate">
                        {vault.name}
                      </span>
                      <span className="text-xs text-muted-foreground block truncate">
                        {vault.noteCount} notes
                      </span>
                    </div>
                    {isActive ? (
                      <Check className="size-4 text-sidebar-terracotta shrink-0" />
                    ) : (
                      <button
                        onClick={(e) => handleRemoveClick(e, vault)}
                        className="size-6 flex items-center justify-center rounded-md opacity-0 group-hover/vault:opacity-100 hover:bg-accent transition-all"
                        aria-label={`Remove ${vault.name} from list`}
                      >
                        <X className="size-3.5 text-muted-foreground" />
                      </button>
                    )}
                  </DropdownMenuItem>
                )
              })
            ) : (
              <div className="px-2 py-3 text-sm text-muted-foreground text-center">
                No vaults yet
              </div>
            )}

            <DropdownMenuSeparator className="my-2 -mx-2" />

            {/* Select new vault */}
            <DropdownMenuItem
              onClick={handleSelectNewVault}
              className="rounded-lg cursor-pointer hover:bg-accent focus:bg-accent transition-colors"
            >
              <div className="flex size-7 items-center justify-center">
                <Plus className="size-4 text-muted-foreground" />
              </div>
              <span className="text-muted-foreground">Open Another Vault</span>
            </DropdownMenuItem>

            <DropdownMenuSeparator className="my-2 -mx-2" />

            {/* Templates */}
            <DropdownMenuItem
              onClick={handleOpenTemplates}
              className="rounded-lg cursor-pointer hover:bg-accent focus:bg-accent transition-colors"
            >
              <div className="flex size-7 items-center justify-center">
                <LayoutTemplate className="size-4 text-muted-foreground" />
              </div>
              <span className="text-muted-foreground">Templates</span>
            </DropdownMenuItem>

            {/* Settings */}
            <DropdownMenuItem
              onClick={handleOpenSettings}
              className="rounded-lg cursor-pointer hover:bg-accent focus:bg-accent transition-colors"
            >
              <div className="flex size-7 items-center justify-center">
                <Settings className="size-4 text-muted-foreground" />
              </div>
              <span className="text-muted-foreground">Settings</span>
            </DropdownMenuItem>
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
              always re-add it later using &ldquo;Open Another Vault&rdquo;.
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
