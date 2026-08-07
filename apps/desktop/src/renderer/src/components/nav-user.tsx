import { BadgeCheck, Bell, ChevronsUpDown, CreditCard, LogOut, Sparkles } from '@/lib/icons'
import { useState } from 'react'

import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'
import { useT } from '@memry/i18n/renderer'
import {
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  useSidebar
} from '@/components/ui/sidebar'
import { useSettingsModal } from '@/contexts/settings-modal-context'
import { extractErrorMessage } from '@/lib/ipc-error'
import { toast } from 'sonner'

export function NavUser({
  user
}: {
  user: {
    name: string
    email: string
    avatar: string
  }
}) {
  const { t: tPhaseF } = useT('common')
  const { t: tSettings } = useT('settings')
  const { isMobile } = useSidebar()
  const { open: openSettings } = useSettingsModal()
  const [isStartingCheckout, setIsStartingCheckout] = useState(false)

  const handleUpgrade = async (): Promise<void> => {
    setIsStartingCheckout(true)
    try {
      const result = await window.api.account.startCheckout()
      if (!result.success) {
        toast.error(result.error ?? tSettings('account.billing.toasts.checkoutFailed'))
        return
      }
      toast.success(tSettings('account.billing.toasts.checkoutOpened'))
    } catch (error: unknown) {
      toast.error(extractErrorMessage(error, tSettings('account.billing.toasts.checkoutFailed')))
    } finally {
      setIsStartingCheckout(false)
    }
  }

  return (
    <SidebarMenu>
      <SidebarMenuItem>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <SidebarMenuButton
              size="sm"
              className="data-[state=open]:bg-sidebar-accent data-[state=open]:text-sidebar-accent-foreground"
            >
              <Avatar className="h-8 w-8 rounded-full">
                <AvatarImage src={user.avatar} alt={user.name} />
                <AvatarFallback className="rounded-full">
                  {tPhaseF('phaseF.componentsNavUser.cn')}
                </AvatarFallback>
              </Avatar>
              <div className="grid flex-1 text-start text-sm leading-tight">
                <span className="truncate font-semibold">{user.name}</span>
                <span className="truncate text-xs">{user.email}</span>
              </div>
              <ChevronsUpDown className="ms-auto size-4" />
            </SidebarMenuButton>
          </DropdownMenuTrigger>
          <DropdownMenuContent
            className="w-(--radix-dropdown-menu-trigger-width) min-w-56 rounded-md"
            side={isMobile ? 'bottom' : 'right'}
            align="end"
            sideOffset={4}
          >
            <DropdownMenuLabel className="p-0 font-normal">
              <div className="flex items-center gap-2 px-1 py-1.5 text-start text-sm">
                <Avatar className="h-8 w-8 rounded-md">
                  <AvatarImage src={user.avatar} alt={user.name} />
                  <AvatarFallback className="rounded-md">
                    {tPhaseF('phaseF.componentsNavUser.cn2')}
                  </AvatarFallback>
                </Avatar>
                <div className="grid flex-1 text-start text-sm leading-tight">
                  <span className="truncate font-semibold">{user.name}</span>
                  <span className="truncate text-xs">{user.email}</span>
                </div>
              </div>
            </DropdownMenuLabel>
            <DropdownMenuSeparator />
            <DropdownMenuGroup>
              <DropdownMenuItem
                disabled={isStartingCheckout}
                onSelect={(event) => {
                  event.preventDefault()
                  void handleUpgrade()
                }}
              >
                <Sparkles />

                {tPhaseF('phaseF.componentsNavUser.upgradeToPro')}
              </DropdownMenuItem>
            </DropdownMenuGroup>
            <DropdownMenuSeparator />
            <DropdownMenuGroup>
              <DropdownMenuItem onSelect={() => openSettings('account')}>
                <BadgeCheck />

                {tPhaseF('phaseF.componentsNavUser.account')}
              </DropdownMenuItem>
              <DropdownMenuItem onSelect={() => openSettings('account')}>
                <CreditCard />

                {tPhaseF('phaseF.componentsNavUser.billing')}
              </DropdownMenuItem>
              <DropdownMenuItem>
                <Bell />

                {tPhaseF('phaseF.componentsNavUser.notifications')}
              </DropdownMenuItem>
            </DropdownMenuGroup>
            <DropdownMenuSeparator />
            <DropdownMenuItem>
              <LogOut />

              {tPhaseF('phaseF.componentsNavUser.logOut')}
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </SidebarMenuItem>
    </SidebarMenu>
  )
}
