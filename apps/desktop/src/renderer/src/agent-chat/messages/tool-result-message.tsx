import type { Message } from '@memry/contracts/ipc-agent'
import { useT } from '@memry/i18n/renderer'

import { formatUnknown } from './format'

export function ToolResultMessage({ message }: { message: Message }): React.JSX.Element | null {
  const { t } = useT('common')

  if (message.content.role !== 'tool_result') return null

  const { data } = message.content

  return (
    <article className="rounded-md border border-sidebar-border bg-background p-3 text-xs">
      <div className="flex items-center justify-between gap-2">
        <span className="font-medium text-foreground">{t('agentChat.toolResult.label')}</span>
        <span className={data.ok ? 'text-emerald-700 dark:text-emerald-400' : 'text-destructive'}>
          {data.ok ? t('agentChat.toolResult.ok') : t('agentChat.toolResult.failed')}
        </span>
      </div>
      <pre className="mt-2 max-h-36 overflow-auto whitespace-pre-wrap break-words text-muted-foreground">
        {formatUnknown(data.ok ? data.data : data.error)}
      </pre>
    </article>
  )
}
