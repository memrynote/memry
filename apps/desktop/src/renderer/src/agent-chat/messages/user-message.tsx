import type { Message } from '@memry/contracts/ipc-agent'

export function UserMessage({ message }: { message: Message }): React.JSX.Element | null {
  if (message.content.role !== 'user') return null

  return (
    <article className="flex justify-end">
      <div className="max-w-[85%] rounded-lg bg-primary px-3 py-2 text-sm text-primary-foreground">
        <p className="whitespace-pre-wrap break-words">{message.content.data.text}</p>
        {message.attachments.length > 0 && (
          <div className="mt-2 flex flex-wrap justify-end gap-1">
            {message.attachments.map((attachment) => (
              <span
                key={`${attachment.kind}-${attachment.refId}`}
                className="rounded-full bg-primary-foreground/15 px-2 py-0.5 text-xs"
              >
                {attachment.label}
              </span>
            ))}
          </div>
        )}
      </div>
    </article>
  )
}
