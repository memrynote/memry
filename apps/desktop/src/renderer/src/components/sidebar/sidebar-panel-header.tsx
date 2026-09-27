import { useT } from '@memry/i18n/renderer'
import { ChevronDown, PenLine, Search } from '@/lib/icons'
import { Kbd } from '@/components/ui/kbd'
import { Picker } from '@/components/ui/picker'
import { NewItemMenuItems, type NewItemActions } from '@/components/tabs/new-item-menu-items'
import {
  SidebarVaultHeader,
  type SidebarVaultPages
} from '@/components/sidebar/sidebar-vault-paging'
import { formatBinding } from '@/lib/shortcut-registry'
import { useShortcutBinding } from '@/lib/shortcut-bindings'
import { cn } from '@/lib/utils'

interface SidebarPanelHeaderProps {
  pages: SidebarVaultPages
  onNewNote: () => void
  newItemActions: NewItemActions
}

const FOCUS_RING =
  'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sidebar-primary'

/**
 * Top of the sidebar panel: the vault switcher with a search button, then New
 * (a note, or anything from its menu). It renders inside the vault pager, so a swipe
 * carries the incoming vault's name in with its page. Stays visible during
 * drill-down.
 */
export function SidebarPanelHeader({
  pages,
  onNewNote,
  newItemActions
}: SidebarPanelHeaderProps): React.JSX.Element {
  const { t } = useT('common')
  const searchBinding = useShortcutBinding('nav.search')
  const newNoteBinding = useShortcutBinding('nav.newNote')
  const openSearch = (): void => {
    window.dispatchEvent(new CustomEvent('memry:open-search'))
  }

  return (
    <div className="flex shrink-0 flex-col gap-2 px-3 pt-1 pb-4 group-data-[collapsible=icon]:hidden">
      <div className="flex items-center justify-between gap-1">
        <SidebarVaultHeader pages={pages} />
        <button
          type="button"
          data-testid="sidebar-search"
          onClick={openSearch}
          aria-label={t('sidebar.search')}
          title={`${t('sidebar.search')} (${formatBinding(searchBinding)})`}
          className={cn(
            'flex size-[30px] shrink-0 items-center justify-center rounded-[7px] text-sidebar-foreground transition-colors hover:bg-sidebar-accent hover:text-sidebar-primary',
            FOCUS_RING
          )}
        >
          <Search className="size-[15px]" aria-hidden="true" />
        </button>
      </div>
      <div className="flex h-8 items-center rounded-[7px] bg-sidebar-accent">
        <button
          type="button"
          data-tour="new-note"
          onClick={onNewNote}
          title={t('phaseF.componentsAppSidebar.newNoteN')}
          className={cn(
            'flex h-full min-w-0 flex-1 items-center gap-2 rounded-s-[7px] ps-2.5 pe-1.5 text-start text-[13px] text-sidebar-primary transition-colors hover:bg-sidebar-accent-foreground/5',
            FOCUS_RING
          )}
        >
          <PenLine className="size-3.5 shrink-0" aria-hidden="true" />
          <span className="min-w-0 flex-1 truncate">
            {t('phaseF.componentsAppSidebar.newNote')}
          </span>
          <Kbd className="h-[18px] bg-background text-[10px] text-sidebar-foreground shadow-[0_0_0_1px_var(--sidebar-border)]">
            {formatBinding(newNoteBinding)}
          </Kbd>
        </button>
        <span aria-hidden="true" className="h-4 w-px shrink-0 bg-sidebar-border" />
        <Picker>
          <Picker.Trigger asChild>
            <button
              type="button"
              aria-label={t('phaseF.componentsAppSidebar.newItemMenu')}
              className={cn(
                'flex h-full w-7 shrink-0 items-center justify-center rounded-e-[7px] text-sidebar-foreground transition-colors hover:bg-sidebar-accent-foreground/5 data-[state=open]:bg-sidebar-accent-foreground/5',
                FOCUS_RING
              )}
            >
              <ChevronDown className="size-3" aria-hidden="true" />
            </button>
          </Picker.Trigger>
          <Picker.Content width={200} align="end" side="bottom">
            <NewItemMenuItems actions={newItemActions} />
          </Picker.Content>
        </Picker>
      </div>
    </div>
  )
}
