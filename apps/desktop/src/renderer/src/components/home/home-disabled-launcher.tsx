import { Plus } from '@/lib/icons'
import { useT } from '@memry/i18n/renderer'

interface HomeDisabledLauncherProps {
  onCreateNote: () => void
}

export function HomeDisabledLauncher({ onCreateNote }: HomeDisabledLauncherProps) {
  const { t } = useT('common')
  return (
    <div className="flex h-full w-full flex-col items-center justify-center gap-3">
      <button
        type="button"
        onClick={onCreateNote}
        className="flex flex-col items-center gap-2 rounded-lg border border-border px-8 py-6 text-muted-foreground transition-colors hover:text-foreground"
      >
        <Plus className="size-6" />
        <span className="text-sm font-medium">{t('home.disabled.createNote')}</span>
      </button>
      <p className="text-xs text-muted-foreground">{t('home.disabled.hint')}</p>
    </div>
  )
}
