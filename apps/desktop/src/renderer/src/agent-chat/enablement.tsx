import { useT } from '@memry/i18n/renderer'

import { Button } from '@/components/ui/button'

interface EnablementProps {
  onAccept: () => void | Promise<void>
}

export function Enablement({ onAccept }: EnablementProps): React.JSX.Element {
  const { t } = useT('common')

  return (
    <div className="flex h-full flex-col items-start gap-4 p-5">
      <div className="space-y-1">
        <h2 className="text-base font-semibold text-foreground">{t('agentChat.enable.title')}</h2>
        <p className="text-sm leading-6 text-muted-foreground">
          {t('agentChat.enable.description')}
        </p>
      </div>
      <div className="space-y-2 text-sm leading-5 text-muted-foreground">
        <p>{t('agentChat.enable.remote')}</p>
        <ul className="list-disc space-y-1 ps-5">
          <li>{t('agentChat.enable.readTools')}</li>
          <li>{t('agentChat.enable.writeTools')}</li>
          <li>{t('agentChat.enable.diff')}</li>
        </ul>
      </div>
      <Button size="sm" onClick={() => void onAccept()}>
        {t('agentChat.enable.button')}
      </Button>
    </div>
  )
}
