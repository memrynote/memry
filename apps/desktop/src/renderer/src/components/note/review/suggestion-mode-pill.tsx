import { X } from '@/lib/icons'
import { Button } from '@/components/ui/button'
import { useT } from '@memry/i18n/renderer'

export function SuggestionModePill({ onClose }: { onClose: () => void }) {
  const { t } = useT('notes')

  return (
    <div className="suggestion-mode-pill" data-marquee-ignore>
      <span>{t('comments.suggesting')}</span>
      <Button
        type="button"
        variant="ghost"
        size="icon-sm"
        className="size-5"
        aria-label={t('comments.exitSuggestionMode')}
        onClick={onClose}
      >
        <X className="size-3" aria-hidden="true" />
      </Button>
    </div>
  )
}
