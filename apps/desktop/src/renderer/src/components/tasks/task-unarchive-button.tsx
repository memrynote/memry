import { RotateCcw } from '@/lib/icons'
import { useT } from '@memry/i18n/renderer'

interface TaskUnarchiveButtonProps {
  onUnarchive: () => void
}

/**
 * The way back out of the archive. Archiving is otherwise a one-way door: the
 * task list hides archived tasks unless the archived scope is selected, and a
 * task reached from global search opens straight into this drawer.
 */
export const TaskUnarchiveButton = ({
  onUnarchive
}: TaskUnarchiveButtonProps): React.JSX.Element => {
  const { t } = useT('tasks')

  return (
    <button
      type="button"
      onClick={onUnarchive}
      className="flex items-center gap-2 py-1.5 px-2.5 rounded-md text-[12px] leading-4 text-foreground hover:bg-muted transition-colors w-full"
      aria-label={t('task.unarchive')}
    >
      <RotateCcw size={14} />
      {t('task.unarchive')}
    </button>
  )
}
