import type { BinaryStatus } from '@memry/contracts/ipc-agent'

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
  const canCreate = binaryStatus?.detected === true && binaryStatus.meetsMinimum

  return (
    <div className="flex h-full flex-col items-start gap-3 p-5">
      <div className="space-y-1">
        <h2 className="text-base font-semibold text-foreground">Start chatting with your vault</h2>
        <BinaryLine status={binaryStatus} />
      </div>
      <Button
        size="sm"
        onClick={() => void onCreateConversation()}
        disabled={!canCreate || creating}
      >
        <Plus className="size-4" aria-hidden="true" />
        New conversation
      </Button>
    </div>
  )
}

function BinaryLine({ status }: { status: BinaryStatus | null }): React.JSX.Element {
  if (!status) {
    return <p className="text-sm text-muted-foreground">Checking Claude CLI...</p>
  }
  if (!status.detected) {
    return (
      <p className="text-sm text-amber-700 dark:text-amber-400">
        claude not found. {status.installHint}
      </p>
    )
  }
  if (!status.meetsMinimum) {
    return (
      <p className="text-sm text-amber-700 dark:text-amber-400">
        claude {status.version} is too old. Need {status.minimumRequired}. {status.installHint}
      </p>
    )
  }
  return (
    <p className="text-sm text-emerald-700 dark:text-emerald-400">
      claude {status.version} detected and ready.
    </p>
  )
}
