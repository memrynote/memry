import { AlertCircle } from '@/lib/icons'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import { useT } from '@memry/i18n/renderer'

export function GraphRenderUnavailable({
  className,
  onClose
}: {
  className?: string
  onClose?: () => void
}): React.JSX.Element {
  const { t } = useT('graph')
  const { t: tCommon } = useT('common')

  return (
    <div
      role="status"
      className={cn(
        'flex h-full flex-col items-center justify-center gap-3 p-8 text-center',
        className
      )}
    >
      <AlertCircle className="size-8 text-destructive/60" />
      <div className="space-y-1">
        <p className="text-sm text-destructive/80 font-serif">{t('page.render-failed')}</p>
        <p className="max-w-md text-sm text-muted-foreground">
          {t('page.render-failed-description')}
        </p>
      </div>
      {onClose && (
        <Button variant="outline" size="sm" onClick={onClose}>
          {tCommon('button.close')}
        </Button>
      )}
    </div>
  )
}
