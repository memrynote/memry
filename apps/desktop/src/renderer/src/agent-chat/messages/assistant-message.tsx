import type { Message } from '@main/agent/storage/types'

export function AssistantMessage({ message }: { message: Message }): React.JSX.Element | null {
  if (message.content.role !== 'assistant') return null

  return (
    <article className="flex justify-start">
      <div className="max-w-[92%] rounded-lg border border-sidebar-border bg-background px-3 py-2 text-sm text-foreground">
        <p className="whitespace-pre-wrap break-words leading-6">{message.content.data.text}</p>
      </div>
    </article>
  )
}
