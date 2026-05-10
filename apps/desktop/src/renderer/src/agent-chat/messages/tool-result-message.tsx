import type { Message } from '@main/agent/storage/types'

import { formatUnknown } from './format'

export function ToolResultMessage({ message }: { message: Message }): React.JSX.Element | null {
  if (message.content.role !== 'tool_result') return null

  const { data } = message.content

  return (
    <article className="rounded-md border border-sidebar-border bg-background p-3 text-xs">
      <div className="flex items-center justify-between gap-2">
        <span className="font-medium text-foreground">Tool result</span>
        <span className={data.ok ? 'text-emerald-700 dark:text-emerald-400' : 'text-destructive'}>
          {data.ok ? 'ok' : 'failed'}
        </span>
      </div>
      <pre className="mt-2 max-h-36 overflow-auto whitespace-pre-wrap break-words text-muted-foreground">
        {formatUnknown(data.ok ? data.data : data.error)}
      </pre>
    </article>
  )
}
