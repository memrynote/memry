import type { CrdtRemoteBodyWait } from '@memry/contracts/ipc-crdt'
import { CloudOff, KeyRound, Loader2, UserX } from '@/lib/icons'
import { useAuthOptional } from '@/contexts/auth-context'
import { useSyncOptional } from '@/contexts/sync-context'
import { useT } from '@memry/i18n/renderer'

type ReadOnlyReason = 'stuck' | 'offline' | 'signed-out' | 'vault-locked'

/**
 * Whether an editor waiting for its note's server body shows the vault file
 * read-only (#5290, D-UNMERGED-OPEN-EXIT-2): once the body cannot be merged
 * for now (`stuck`), while the session has ended (`signed-out`, #5342), while
 * no vault key can be read (`vault-locked`), or while the device is offline.
 * Main answers `signed-out` once, at open, so a window that is signed in again
 * goes back to the loading state until the owed pull merges. Otherwise the
 * wait is short and the loading state shows. The file is never written into the doc,
 * so nothing is typed beside a server body that merges later.
 */
export function useRemoteBodyReadOnly(
  remoteWait: CrdtRemoteBodyWait | null
): ReadOnlyReason | null {
  const offline = useSyncOptional()?.state.status === 'offline'
  const signedIn = useAuthOptional()?.state.status === 'authenticated'
  if (remoteWait === null) return null
  if (offline) return 'offline'
  if (remoteWait === 'signed-out' && signedIn) return null
  return remoteWait === 'merging' ? null : remoteWait
}

const NOTICE = {
  offline: { Icon: CloudOff, spin: false, key: 'editor.remoteBodyOffline' },
  'signed-out': { Icon: UserX, spin: false, key: 'editor.remoteBodySignedOut' },
  'vault-locked': { Icon: KeyRound, spin: false, key: 'editor.remoteBodyVaultLocked' },
  stuck: { Icon: Loader2, spin: true, key: 'editor.remoteBodyStuck' }
} as const

/** The strip above a read-only vault file that waits for its synced body. */
export function RemoteBodyWaitNotice({ reason }: { reason: ReadOnlyReason }) {
  const { t } = useT('notes')
  const { Icon, spin, key } = NOTICE[reason]
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
          spin ? 'h-3 w-3 shrink-0 animate-spin motion-reduce:animate-none' : 'h-3 w-3 shrink-0'
        }
      />
      <span className="truncate">{t(key)}</span>
    </div>
  )
}
