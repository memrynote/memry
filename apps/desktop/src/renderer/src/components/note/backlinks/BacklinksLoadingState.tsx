import { Loader2 } from '@/lib/icons'
import { useT } from '@memry/i18n/renderer'

export function BacklinksLoadingState() {
  const { t } = useT('common')

  return (
    <div className="flex items-center gap-1.5 px-1.5 py-2">
      <Loader2 className="h-3 w-3 text-text-tertiary animate-spin" />
      <span className="text-[11px] text-text-tertiary">{t('state.loading')}</span>
    </div>
  )
}
