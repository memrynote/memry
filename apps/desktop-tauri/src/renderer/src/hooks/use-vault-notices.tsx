/**
 * Shows the open vault's notices (Step 14l, #3531): a state of the vault the user can act on
 * that no screen shows otherwise. Each notice is one persistent toast with an action, updated
 * in place while it holds and taken down when it clears. A notice the user closed stays closed
 * until it clears and is raised again; a notice of the next vault starts fresh.
 */

import { useEffect } from 'react'
import { toast } from 'sonner'
import { useT } from '@memry/i18n/renderer'
import type { VaultNotice } from '../../../generated/bindings'
import { commands } from '../../../generated/bindings'
import { useFileActionLabels } from '@/hooks/use-file-action-labels'
import { createLogger } from '@/lib/logger'
import { onVaultNotices } from '@/services/vault-service'

const log = createLogger('VaultNotices')

/**
 * Raises the inotify watch limit now and at every boot. A shell command, never translated:
 * 524288 is the limit current distributions ship as their default.
 */
export const WATCH_LIMIT_COMMAND =
  'echo fs.inotify.max_user_watches=524288 | sudo tee /etc/sysctl.d/60-memry.conf && sudo sysctl --system'

type Kind = VaultNotice['kind']

const toastId = (kind: Kind): string => `vault-notice-${kind}`

/** The kinds the latest list holds, and the ones the user closed meanwhile. */
const current = new Set<Kind>()
const closed = new Set<Kind>()

/** Listens for the open vault's notices. Should be used once in the vault shell. */
export function useVaultNotices(): void {
  const { t } = useT('common')
  const { revealInFolder } = useFileActionLabels()

  useEffect(() => {
    const show = (notice: VaultNotice): void => {
      const sticky = {
        id: toastId(notice.kind),
        duration: Infinity,
        closeButton: true,
        // Sonner also calls this for a toast taken down here, once its notice cleared.
        onDismiss: () => {
          if (current.has(notice.kind)) closed.add(notice.kind)
        }
      }
      switch (notice.kind) {
        case 'configUnreadable':
          toast.warning(t('vaultNotice.configUnreadable'), {
            ...sticky,
            description: t('vaultNotice.configUnreadableHint'),
            action: {
              label: revealInFolder,
              onClick: (event) => {
                event.preventDefault()
                commands.shellRevealPath(notice.path).catch((error: unknown) => {
                  log.error('the vault config could not be revealed', error)
                  toast.error(t('fileActions.revealFailed'))
                })
              }
            }
          })
          return
        case 'watchLimit':
          toast.warning(t('vaultNotice.watchLimit'), {
            ...sticky,
            description: (
              <>
                {t('vaultNotice.watchLimitHint')}
                <code dir="ltr" className="mt-1 block break-all text-start font-mono text-xs">
                  {WATCH_LIMIT_COMMAND}
                </code>
              </>
            ),
            action: {
              label: t('vaultNotice.copyCommand'),
              onClick: (event) => {
                event.preventDefault()
                navigator.clipboard
                  .writeText(WATCH_LIMIT_COMMAND)
                  .then(() => toast.success(t('vaultNotice.commandCopied')))
                  .catch((error: unknown) => {
                    log.error('the watch limit command could not be copied', error)
                    toast.error(t('vaultNotice.copyFailed'))
                  })
              }
            }
          })
          return
      }
    }

    return onVaultNotices((notices) => {
      const kinds = new Set(notices.map((notice) => notice.kind))
      for (const kind of current) {
        if (kinds.has(kind)) continue
        current.delete(kind)
        closed.delete(kind)
        toast.dismiss(toastId(kind))
      }
      for (const notice of notices) {
        current.add(notice.kind)
        if (!closed.has(notice.kind)) show(notice)
      }
    })
  }, [t, revealInFolder])
}
