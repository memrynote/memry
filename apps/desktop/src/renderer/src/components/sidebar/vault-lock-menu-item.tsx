/**
 * VaultLockMenuItem
 * A context-menu row that locks or unlocks a note or a folder (#2606). A
 * locked note is read-only for the editor and for every agent write path.
 */

import { toast } from 'sonner'
import { Lock } from '@/lib/icons'
import { ContextMenuItem } from '@/components/ui/context-menu'
import { extractErrorMessage } from '@/lib/ipc-error'
import { setVaultLock, useVaultLockState } from '@/lib/vault-locks-store'
import { useT } from '@memry/i18n/renderer'
import type { VaultLockTargetKind } from '@memry/contracts/vault-locks-api'

interface VaultLockMenuItemProps {
  kind: VaultLockTargetKind
  /** Note id for a note, vault-relative path for a folder. */
  target: string
}

export function VaultLockMenuItem({ kind, target }: VaultLockMenuItemProps): React.JSX.Element {
  const { t } = useT('notes')
  const locks = useVaultLockState()
  const locked = kind === 'note' ? locks.notes.includes(target) : locks.folders.includes(target)

  const toggle = async (): Promise<void> => {
    try {
      await setVaultLock(kind, target, !locked)
    } catch (err) {
      toast.error(extractErrorMessage(err, t('vaultLock.toggleFailed')))
    }
  }

  return (
    <ContextMenuItem onClick={() => void toggle()}>
      <Lock className="me-2 h-4 w-4" />
      {locked
        ? t(kind === 'note' ? 'vaultLock.unlockNote' : 'vaultLock.unlockFolder')
        : t(kind === 'note' ? 'vaultLock.lockNote' : 'vaultLock.lockFolder')}
    </ContextMenuItem>
  )
}
