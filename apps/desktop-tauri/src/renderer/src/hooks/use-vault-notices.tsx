/**
 * Shows the open vault's notices (Step 14l, #3531): a state of the vault the user can act on
 * that no screen shows otherwise. Each notice is one persistent toast with an action, updated
 * in place while it holds (a list notice as its list grows) and taken down when it clears. A notice the user closed stays closed
 * until it clears and is raised again; a notice of the next vault starts fresh.
 */

import { useEffect, type ReactNode } from 'react'
import { toast } from 'sonner'
import { useT } from '@memry/i18n/renderer'
import type { VaultNotice } from '../../../generated/bindings'
import { commands } from '../../../generated/bindings'
import { useFileActionLabels } from '@/hooks/use-file-action-labels'
import { createLogger } from '@/lib/logger'
import { flushAllPendingSaves } from '@/lib/save-registry'
import { onVaultNotices } from '@/services/vault-service'

const log = createLogger('VaultNotices')

/**
 * Raises the inotify watch limit now and at every boot. A shell command, never translated.
 * Since Linux 5.11 the default scales with the machine's memory up to 1048576; this sets that
 * ceiling.
 */
export const WATCH_LIMIT_COMMAND =
  'echo fs.inotify.max_user_watches=1048576 | sudo tee /etc/sysctl.d/60-memry.conf && sudo sysctl --system'

type Kind = VaultNotice['kind']

/** How many names a list notice spells out; the rest are counted. */
const NAMED = 3

/** A path's last part, on any platform's separators. */
const fileName = (path: string): string => path.split(/[\\/]/).pop() || path

/**
 * A list notice's hint and the first names it lists, each isolated so a name in another
 * script keeps its order; past [NAMED] names, a count of the rest (`+` when the vault has more
 * than it listed). With no name left but more in the vault, `unlisted` says so instead.
 */
function listed(
  hint: string,
  items: { key: string; name: string }[],
  more: boolean,
  unlisted: string
): ReactNode {
  const rest = items.length - NAMED
  return (
    <>
      {hint}
      <span className="mt-1 block text-start">
        {items.length === 0 && more
          ? unlisted
          : items.slice(0, NAMED).map(({ key, name }, at) => (
              <span key={key}>
                {at > 0 && ', '}
                <bdi>{name}</bdi>
              </span>
            ))}
        {items.length > 0 && (rest > 0 || more) && (
          <bdi dir="ltr">{` +${Math.max(rest, 0)}${more ? '+' : ''}`}</bdi>
        )}
      </span>
    </>
  )
}

const toastId = (kind: Kind): string => `vault-notice-${kind}`

/**
 * The open the latest list belongs to, the kinds it holds, and the ones the user closed
 * meanwhile in that open.
 */
let shownOpen: number | null = null
const current = new Set<Kind>()
const closed = new Set<Kind>()
/** A click that turns renamed journal entries into notes is still being answered. */
let crossing = false

/** Listens for the open vault's notices. Should be used once in the vault shell. */
export function useVaultNotices(): void {
  const { t } = useT('common')
  const { revealInFolder } = useFileActionLabels()

  useEffect(() => {
    /** Reveals `path` in the file manager, logging `what` when it cannot. */
    const reveal = (path: string, what: string) => ({
      label: revealInFolder,
      onClick: (event: { preventDefault: () => void }) => {
        event.preventDefault()
        commands.shellRevealPath(path).catch((error: unknown) => {
          log.error(`${what} could not be revealed`, error)
          toast.error(t('fileActions.revealFailed'))
        })
      }
    })

    /** `changeWaits`: a journal setting change waits, which owns the days until it settles. */
    const show = (notice: VaultNotice, changeWaits: boolean): void => {
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
        case 'undecidedFiles': {
          const [first] = notice.paths
          toast.warning(t('vaultNotice.undecidedFiles'), {
            ...sticky,
            description: listed(
              t('vaultNotice.undecidedFilesHint'),
              notice.paths.map((path) => ({ key: path, name: fileName(path) })),
              notice.more,
              t('vaultNotice.moreUnlisted')
            ),
            action: first
              ? {
                  label: revealInFolder,
                  onClick: (event) => {
                    event.preventDefault()
                    commands.shellRevealPath(first).catch((error: unknown) => {
                      log.error('an undecided file could not be revealed', error)
                      toast.error(t('fileActions.revealFailed'))
                    })
                  }
                }
              : undefined
          })
          return
        }
        // No action: the note page reads the note's file, which is gone (Electron's
        // `getNoteById` parity), so an opened kept note would show nothing.
        case 'keptRemovals':
          toast.warning(t('vaultNotice.keptRemovals'), {
            ...sticky,
            description: listed(
              t('vaultNotice.keptRemovalsHint'),
              notice.notes.map((note) => ({
                key: note.noteId,
                name: fileName(note.path).replace(/\.md$/i, '')
              })),
              notice.more,
              t('vaultNotice.moreUnlisted')
            )
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
        case 'journalDaysHeld': {
          const [first] = notice.folders
          toast.warning(t('vaultNotice.journalDaysHeld'), {
            ...sticky,
            description: listed(
              t('vaultNotice.journalDaysHeldHint'),
              notice.folders.map((folder) => ({ key: folder, name: fileName(folder) })),
              false,
              t('vaultNotice.moreUnlisted')
            ),
            action: first ? reveal(first, 'a held journal folder') : undefined
          })
          return
        }
        case 'journalChangeWaits': {
          const { holds } = notice
          const hint = {
            settings: t('vaultNotice.journalChangeWaitsSettingsHint'),
            taken: t('vaultNotice.journalChangeWaitsTakenHint'),
            refused: t('vaultNotice.journalChangeWaitsRefusedHint'),
            unknown: t('vaultNotice.journalChangeWaitsHint')
          }[holds.kind]
          toast.warning(t('vaultNotice.journalChangeWaits'), {
            ...sticky,
            description:
              holds.kind === 'taken'
                ? listed(hint, [{ key: holds.path, name: fileName(holds.path) }], false, '')
                : hint,
            action:
              holds.kind === 'unknown' || holds.kind === 'refused'
                ? undefined
                : reveal(holds.path, 'what holds a journal change')
          })
          return
        }
        case 'movesWait': {
          const [first] = notice.notes
          toast.warning(t('vaultNotice.movesWait'), {
            ...sticky,
            description: listed(
              t('vaultNotice.movesWaitHint'),
              notice.notes.map((note) => ({
                key: note.noteId,
                name: fileName(note.path).replace(/\.md$/i, '')
              })),
              notice.more,
              t('vaultNotice.moreUnlisted')
            ),
            action: first ? reveal(first.path, 'a note whose move waits') : undefined
          })
          return
        }
        // Electron crosses each of these into a note at the rename; here the user does.
        case 'journalDaysRenamed': {
          const ids = notice.days.map((day) => day.noteId)
          const cross = (): void => {
            if (crossing) return
            crossing = true
            // Typing not saved yet reaches the day's file first, so the note holds it, and no
            // save of it lands after the day is deleted and makes it again.
            flushAllPendingSaves()
              .then(() => commands.journalCrossIntoNotes(ids))
              .then(({ crossed }) => {
                if (crossed < ids.length) toast.error(t('toast.actionFailed'))
              })
              .catch((error: unknown) => {
                log.error('renamed journal entries could not be turned into notes', error)
                toast.error(t('toast.actionFailed'))
              })
              .finally(() => {
                crossing = false
              })
          }
          toast.warning(t('vaultNotice.journalDaysRenamed'), {
            ...sticky,
            description: listed(
              t('vaultNotice.journalDaysRenamedHint'),
              notice.days.map((day) => ({
                key: day.noteId,
                name: fileName(day.path).replace(/\.md$/i, '')
              })),
              notice.more,
              t('vaultNotice.moreUnlisted')
            ),
            // Refused while the change waits: its own notice is up.
            action:
              ids.length > 0 && !changeWaits
                ? {
                    label: t('vaultNotice.turnIntoNotes'),
                    onClick: (event) => {
                      // The toast goes when the notice clears.
                      event.preventDefault()
                      cross()
                    }
                  }
                : undefined
          })
          return
        }
      }
    }

    return onVaultNotices(({ open, notices }) => {
      if (open !== shownOpen) {
        shownOpen = open
        closed.clear()
      }
      const kinds = new Set(notices.map((notice) => notice.kind))
      for (const kind of current) {
        if (kinds.has(kind)) continue
        current.delete(kind)
        closed.delete(kind)
        toast.dismiss(toastId(kind))
      }
      const changeWaits = kinds.has('journalChangeWaits')
      for (const notice of notices) {
        current.add(notice.kind)
        if (!closed.has(notice.kind)) show(notice, changeWaits)
      }
    })
  }, [t, revealInFolder])
}
