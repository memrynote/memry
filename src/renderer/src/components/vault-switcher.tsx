'use client'

import {
  ChevronsUpDown,
  Plus,
  Check,
  FolderOpen,
  HardDrive,
  Loader2,
  LayoutTemplate,
  Settings
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
import { useVault, useVaultList } from '@/hooks/use-vault'
import { useTabActions } from '@/contexts/tabs'

export function VaultSwitcher() {
  const { isMobile } = useSidebar()
  const { status, isLoading, selectVault, switchVault } = useVault()
  const { vaults } = useVaultList()
  const { openTab } = useTabActions()

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

  return (
    <SidebarMenu>
      <SidebarMenuItem>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <SidebarMenuButton
              size="lg"
              className="bg-white rounded-lg gap-2 border border-gray-200/60 data-[state=open]:bg-sidebar-accent data-[state=open]:text-sidebar-accent-foreground group-data-[collapsible=icon]:justify-center"
            >
              <div className="flex aspect-square size-6 items-center justify-center rounded-full bg-indigo-500 text-white">
                {isLoading ? (
                  <Loader2 className="size-3 animate-spin" />
                ) : (
                  <HardDrive className="size-3" />
                )}
              </div>
              <div className="grid flex-1 text-left text-sm leading-tight group-data-[collapsible=icon]:hidden">
                <span className="truncate font-normal">{currentVaultName}</span>
                {status?.isIndexing && (
                  <span className="text-xs text-gray-500">Indexing... {status.indexProgress}%</span>
                )}
              </div>
              <ChevronsUpDown className="ml-auto size-4 group-data-[collapsible=icon]:hidden" />
            </SidebarMenuButton>
          </DropdownMenuTrigger>
          <DropdownMenuContent
            className="w-[--radix-dropdown-menu-trigger-width] min-w-64 rounded-xl p-2 shadow-lg border border-gray-200/80"
            align="start"
            side={isMobile ? 'bottom' : 'right'}
            sideOffset={8}
          >
            {/* Vault list header */}
            <div className="px-2 py-1.5 text-xs font-medium text-gray-500 uppercase tracking-wider">
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
                    className="rounded-lg cursor-pointer hover:bg-gray-100 focus:bg-gray-100 transition-colors"
                  >
                    <div className="flex size-7 items-center justify-center rounded-md border border-gray-200 bg-white">
                      <FolderOpen className="size-4 shrink-0 text-indigo-500" />
                    </div>
                    <div className="flex-1 min-w-0">
                      <span className="font-medium text-gray-900 block truncate">{vault.name}</span>
                      <span className="text-xs text-gray-500 block truncate">
                        {vault.noteCount} notes
                      </span>
                    </div>
                    {isActive && <Check className="size-4 text-indigo-500 shrink-0" />}
                  </DropdownMenuItem>
                )
              })
            ) : (
              <div className="px-2 py-3 text-sm text-gray-500 text-center">No vaults yet</div>
            )}

            <DropdownMenuSeparator className="my-2 -mx-2 bg-gray-200/80" />

            {/* Select new vault */}
            <DropdownMenuItem
              onClick={handleSelectNewVault}
              className="rounded-lg cursor-pointer hover:bg-gray-100 focus:bg-gray-100 transition-colors"
            >
              <div className="flex size-7 items-center justify-center">
                <Plus className="size-4 text-gray-500" />
              </div>
              <span className="text-gray-600">Open Another Vault</span>
            </DropdownMenuItem>

            <DropdownMenuSeparator className="my-2 -mx-2 bg-gray-200/80" />

            {/* Templates */}
            <DropdownMenuItem
              onClick={handleOpenTemplates}
              className="rounded-lg cursor-pointer hover:bg-gray-100 focus:bg-gray-100 transition-colors"
            >
              <div className="flex size-7 items-center justify-center">
                <LayoutTemplate className="size-4 text-gray-500" />
              </div>
              <span className="text-gray-600">Templates</span>
            </DropdownMenuItem>

            {/* Settings */}
            <DropdownMenuItem
              onClick={handleOpenSettings}
              className="rounded-lg cursor-pointer hover:bg-gray-100 focus:bg-gray-100 transition-colors"
            >
              <div className="flex size-7 items-center justify-center">
                <Settings className="size-4 text-gray-500" />
              </div>
              <span className="text-gray-600">Settings</span>
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </SidebarMenuItem>
    </SidebarMenu>
  )
}
