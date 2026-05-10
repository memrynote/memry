import type { BinaryStatus } from '@memry/contracts/ipc-agent'
import { useT } from '@memry/i18n/renderer'

import { Button } from '@/components/ui/button'
import { Plus } from '@/lib/icons'

interface EmptyStateProps {
  binaryStatus: BinaryStatus | null
  creating?: boolean
  onCreateConversation: () => void | Promise<void>
}

export function EmptyState({
  binaryStatus,
  creating = false,
  onCreateConversation
}: EmptyStateProps): React.JSX.Element {
  const { t } = useT('common')
  const canCreate = binaryStatus?.detected === true && binaryStatus.meetsMinimum

  return (
    <div className="flex h-full flex-col items-start gap-3 p-5">
      <div className="space-y-1">
        <h2 className="text-base font-semibold text-foreground">{t('agentChat.startTitle')}</h2>
        <BinaryLine status={binaryStatus} />
      </div>
      <Button
        size="sm"
        onClick={() => void onCreateConversation()}
        disabled={!canCreate || creating}
      >
        <Plus className="size-4" aria-hidden="true" />
        {t('agentChat.newConversation')}
      </Button>
    </div>
  )
}

function BinaryLine({ status }: { status: BinaryStatus | null }): React.JSX.Element {
  const { t } = useT('common')

  if (!status) {
    return <p className="text-sm text-muted-foreground">{t('agentChat.binary.checking')}</p>
  }
  if (!status.detected) {
    return (
      <p className="text-sm text-amber-700 dark:text-amber-400">
        {t('agentChat.binary.notFound', { hint: status.installHint ?? '' })}
      </p>
    )
  }
  if (!status.meetsMinimum) {
    return (
      <p className="text-sm text-amber-700 dark:text-amber-400">
        {t('agentChat.binary.tooOld', {
          version: status.version ?? '',
          minimumRequired: status.minimumRequired,
          hint: status.installHint ?? ''
        })}
      </p>
    )
  }
  return (
    <p className="text-sm text-emerald-700 dark:text-emerald-400">
      {t('agentChat.binary.ready', { version: status.version ?? '' })}
    </p>
  )
}
