import { FileText, BookOpen, Calendar, Inbox, ListTodo, Tags } from '@/lib/icons'
import { Picker } from '@/components/ui/picker'
import { useT } from '@memry/i18n/renderer'

export interface NewItemActions {
  onNewNote: () => void
  onJournal: () => void
  onCalendar: () => void
  onInbox: () => void
  onTasks: () => void
  onTags: () => void
}

interface NewItemMenuItemsProps {
  actions: NewItemActions
}

export function NewItemMenuItems({ actions }: NewItemMenuItemsProps): React.JSX.Element {
  const { t: tPhaseF } = useT('common')

  return (
    <Picker.List>
      <Picker.Item
        value="note"
        label={tPhaseF('phaseF.componentsTabsNewTabMenu.newNote')}
        icon={<FileText className="size-4" />}
        onClick={actions.onNewNote}
      />
      <Picker.Item
        value="journal"
        label={tPhaseF('phaseF.componentsTabsNewTabMenu.journal')}
        icon={<BookOpen className="size-4" />}
        onClick={actions.onJournal}
      />
      <Picker.Item
        value="calendar"
        label={tPhaseF('phaseF.componentsTabsNewTabMenu.calendar')}
        icon={<Calendar className="size-4" />}
        onClick={actions.onCalendar}
      />
      <Picker.Item
        value="inbox"
        label={tPhaseF('phaseF.componentsTabsNewTabMenu.inboxCapture')}
        icon={<Inbox className="size-4" />}
        onClick={actions.onInbox}
      />
      <Picker.Item
        value="tasks"
        label={tPhaseF('phaseF.componentsTabsNewTabMenu.tasks')}
        icon={<ListTodo className="size-4" />}
        onClick={actions.onTasks}
      />
      <Picker.Item
        value="tags"
        label={tPhaseF('phaseF.componentsTabsNewTabMenu.tags')}
        icon={<Tags className="size-4" />}
        onClick={actions.onTags}
      />
    </Picker.List>
  )
}
