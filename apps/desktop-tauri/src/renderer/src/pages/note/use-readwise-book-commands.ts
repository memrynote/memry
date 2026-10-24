import { useCallback, useEffect, useState } from 'react'
import { toast } from 'sonner'
import { useT } from '@memry/i18n/renderer'
import type { Note } from '@/hooks/use-notes-query'
import { extractErrorMessage, unwrapIpcResult } from '@/lib/ipc-error'

export interface ReadwiseBookCommands {
  /** The note carries a Readwise link (`readwise_url`). */
  isLinked: boolean
  /** The commands need the token, which lives on the pulling device only (D8, D16). */
  pullsHere: boolean
  /** The pulling device's name when this device knows it. */
  pullingDeviceName: string | null
  /** Runs after the user confirmed the re-import dialog. */
  reimport: () => Promise<void>
  refresh: () => Promise<void>
}

/**
 * The Re-import and Refresh book info commands of a Readwise note (#1408 D16).
 * Main refuses them on a device that does not pull, so `pullsHere` only decides
 * whether the menu offers them. Until the status arrives, assume this device
 * pulls: the claim is the exception, and main answers either way.
 */
export function useReadwiseBookCommands(note: Note | null): ReadwiseBookCommands {
  const { t } = useT('notes')
  const noteId = note?.id ?? null
  const isLinked = typeof note?.frontmatter.readwise_url === 'string'
  const [pull, setPull] = useState<{ pullsHere: boolean; name: string | null }>({
    pullsHere: true,
    name: null
  })

  useEffect(() => {
    if (!isLinked) return undefined
    let active = true
    void window.api.import.readwise
      .status()
      .then((raw) => {
        if (!active) return
        const status = unwrapIpcResult(raw, t('readwise.commands.failed'))
        setPull({ pullsHere: status.thisDevicePulls, name: status.pullingDeviceName })
      })
      .catch(() => undefined)
    return () => {
      active = false
    }
    // oxlint-disable-next-line react/exhaustive-effect-dependencies -- dependency is an intentional re-run trigger (token/identity), not read by the effect
  }, [isLinked, noteId, t])

  const run = useCallback(
    async (
      command: (input: { noteId: string }) => Promise<unknown>,
      success: string
    ): Promise<void> => {
      if (!noteId) return
      try {
        unwrapIpcResult(await command({ noteId }), t('readwise.commands.failed'))
        toast.success(success)
      } catch (err) {
        toast.error(extractErrorMessage(err, t('readwise.commands.failed')))
      }
    },
    [noteId, t]
  )

  const reimport = useCallback(
    () => run(window.api.import.readwise.reimportBook, t('readwise.commands.reimported')),
    [run, t]
  )
  const refresh = useCallback(
    () => run(window.api.import.readwise.refreshBook, t('readwise.commands.refreshed')),
    [run, t]
  )

  return {
    isLinked,
    pullsHere: pull.pullsHere,
    pullingDeviceName: pull.name,
    reimport,
    refresh
  }
}
