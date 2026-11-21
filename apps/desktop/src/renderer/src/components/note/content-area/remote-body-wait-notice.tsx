import type { CrdtRemoteBodyWait } from '@memry/contracts/ipc-crdt'
import { CloudOff, Loader2 } from '@/lib/icons'
import { useSyncOptional } from '@/contexts/sync-context'
import { useT } from '@memry/i18n/renderer'

/**
 * Whether an editor waiting for its note's server body shows the vault file
 * read-only (#5290, D-UNMERGED-OPEN-EXIT-2): once the body cannot be merged
 * for now (`stuck`), or while the device is offline. Otherwise the wait is
 * short and the loading state shows. The file is never written into the doc,
 * so nothing is typed beside a server body that merges later.
 */
export function useRemoteBodyReadOnly(
  remoteWait: CrdtRemoteBodyWait | null
): 'stuck' | 'offline' | null {
  const offline = useSyncOptional()?.state.status === 'offline'
  if (remoteWait === null) return null
  if (offline) return 'offline'
  return remoteWait === 'stuck' ? 'stuck' : null
}

/** The strip above a read-only vault file that waits for its synced body. */
export function RemoteBodyWaitNotice({ reason }: { reason: 'stuck' | 'offline' }) {
  const { t } = useT('notes')
  const Icon = reason === 'offline' ? CloudOff : Loader2
  return (
    <div
      // oxlint-disable-next-line jsx-a11y/prefer-tag-over-role -- a live status strip; <output> would change its semantics as a form result
      role="status"
      aria-live="polite"
      className="flex items-center gap-2 ps-3 pe-3 py-1.5 text-xs text-muted-foreground bg-muted/40 border-b border-border/60"
    >
      <Icon
        aria-hidden="true"
        className={
          reason === 'offline'
            ? 'h-3 w-3 shrink-0'
            : 'h-3 w-3 shrink-0 animate-spin motion-reduce:animate-none'
        }
      />
      <span className="truncate">
        {t(reason === 'offline' ? 'editor.remoteBodyOffline' : 'editor.remoteBodyStuck')}
      </span>
    </div>
  )
}
