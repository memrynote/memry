import { CheckCircle2 } from 'lucide-react'

interface TriageCompleteProps {
  processedCount: number
  onReturnToInbox: () => void
}

export function TriageComplete({
  processedCount,
  onReturnToInbox
}: TriageCompleteProps): React.JSX.Element {
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-6 p-12">
      <div className="bg-primary/10 flex h-20 w-20 items-center justify-center rounded-full">
        <CheckCircle2 className="text-primary h-10 w-10" />
      </div>

      <div className="text-center">
        <h2 className="text-2xl font-semibold tracking-tight">Inbox Zero</h2>
        <p className="text-muted-foreground mt-2">
          You processed {processedCount} {processedCount === 1 ? 'item' : 'items'}. Nice work.
        </p>
      </div>

      <button
        type="button"
        onClick={onReturnToInbox}
        className="bg-primary text-primary-foreground hover:bg-primary/90 rounded-lg px-6 py-2.5 text-sm font-medium transition-colors"
      >
        Return to Inbox
      </button>
    </div>
  )
}
