import type { Message } from '@memry/contracts/ipc-agent'

import { formatUnknown } from './format'

export function ToolCallMessage({ message }: { message: Message }): React.JSX.Element | null {
  if (message.content.role !== 'tool_call') return null

  return (
    <article className="rounded-md border border-sidebar-border bg-sidebar-accent/40 p-3 text-xs">
      <div className="flex items-center justify-between gap-2">
        <span className="font-medium text-foreground">{message.content.data.tool}</span>
        <span className="rounded-full bg-background px-2 py-0.5 text-muted-foreground">
          {message.content.data.status}
        </span>
      </div>
      <pre className="mt-2 max-h-36 overflow-auto whitespace-pre-wrap break-words text-muted-foreground">
        {formatUnknown(message.content.data.args)}
      </pre>
    </article>
  )
}
