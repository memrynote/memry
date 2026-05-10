import { Button } from '@/components/ui/button'

interface EnablementProps {
  onAccept: () => void | Promise<void>
}

export function Enablement({ onAccept }: EnablementProps): React.JSX.Element {
  return (
    <div className="flex h-full flex-col items-start gap-4 p-5">
      <div className="space-y-1">
        <h2 className="text-base font-semibold text-foreground">Enable Memry Agent</h2>
        <p className="text-sm leading-6 text-muted-foreground">
          Memry Agent uses your local Claude CLI subscription to chat about your vault. Each turn
          sends your message, attached references, prior conversation context, and tool results to
          Anthropic under your Claude account.
        </p>
      </div>
      <div className="space-y-2 text-sm leading-5 text-muted-foreground">
        <p>Memry encrypts your local and synced chat history, but model inference is remote.</p>
        <ul className="list-disc space-y-1 ps-5">
          <li>Read tools run automatically.</li>
          <li>Create and update tools require approval.</li>
          <li>Update tools show a diff or preview.</li>
        </ul>
      </div>
      <Button size="sm" onClick={() => void onAccept()}>
        Enable Claude CLI chat
      </Button>
    </div>
  )
}
