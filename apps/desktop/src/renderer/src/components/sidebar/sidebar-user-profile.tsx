import { useAuth } from '@/contexts/auth-context'
import { useTabActions } from '@/contexts/tabs'
import { useSidebar } from '@/components/ui/sidebar'
import { User } from '@/lib/icons'

export function SidebarUserProfile(): React.JSX.Element | null {
  const { state } = useAuth()
  const { openTab } = useTabActions()
  const { state: sidebarState } = useSidebar()
  const isCollapsed = sidebarState === 'collapsed'

  if (state.status !== 'authenticated' || !state.email) return null

  const displayName = state.email.split('@')[0]
  const initial = displayName.charAt(0).toUpperCase()

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
    <button
      type="button"
      onClick={handleOpenSettings}
      className="flex items-center gap-2 h-8 px-2 w-full rounded-md hover:bg-sidebar-accent/50 transition-colors cursor-pointer"
    >
      <div className="size-[22px] rounded-full bg-sidebar-terracotta flex items-center justify-center shrink-0">
        <span className="text-white font-bold text-[10px] leading-none">{initial}</span>
      </div>
      {!isCollapsed && (
        <>
          <span className="text-sidebar-foreground text-[12.5px] truncate flex-1 text-left">
            {displayName}
          </span>
          <User className="size-3.5 opacity-30 shrink-0 ml-auto" />
        </>
      )}
    </button>
  )
}
