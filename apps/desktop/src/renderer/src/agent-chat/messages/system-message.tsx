import type { Message } from '@main/agent/storage/types'

import { formatUnknown } from './format'

export function SystemMessage({ message }: { message: Message }): React.JSX.Element | null {
  if (message.content.role !== 'system') return null

  return (
    <article className="rounded-md bg-muted/60 p-2 text-xs text-muted-foreground">
      <span className="font-medium text-foreground">{message.content.data.kind}</span>
      <pre className="mt-1 max-h-28 overflow-auto whitespace-pre-wrap break-words">
        {formatUnknown(message.content.data.payload)}
      </pre>
    </article>
  )
}
