/**
 * The delete guard's confirm: a delete that reaches other notes says so, and
 * names them. Closing it any way but "Delete everywhere" cancels, so the one
 * destructive answer always takes a deliberate click.
 *
 * @module note/content-area/portal-flows/portal-delete-dialog
 */

import { useCallback, useRef, useState, type ReactElement, type ReactNode } from 'react'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogTitle
} from '@/components/ui/alert-dialog'
import { buttonVariants } from '@/components/ui/button-variants'
import { useT } from '@memry/i18n/renderer'
import type { PortalHost } from './portal-api'

export type PortalDeleteChoice = 'here' | 'cancel' | 'everywhere'

export interface PortalDeleteRequest {
  subject: 'block' | 'note'
  /** The block's text or the note's title. */
  title: string
  /** Name of the note the content lives in; listed first as "(source)". */
  sourceTitle: string
  hosts: readonly PortalHost[]
  /** True inside a portal, where hiding the block from it is an option. */
  canRemoveHere: boolean
}

interface PortalDeleteDialogProps {
  request: PortalDeleteRequest | null
  onChoose: (choice: PortalDeleteChoice) => void
}

export function PortalDeleteDialog({ request, onChoose }: PortalDeleteDialogProps): ReactElement {
  const { t } = useT('notes')
  const removeRef = useRef<HTMLButtonElement>(null)

  return (
    <AlertDialog open={request !== null} onOpenChange={(open) => !open && onChoose('cancel')}>
      {request ? (
        <AlertDialogContent
          data-testid="portal-delete-dialog"
          className="max-w-[540px] gap-3 rounded-xl p-5"
          onOpenAutoFocus={(event) => {
            // The safe answer is the focused one: hiding the block, else cancel.
            if (!request.canRemoveHere) return
            event.preventDefault()
            removeRef.current?.focus()
          }}
        >
          <AlertDialogTitle className="text-base font-semibold leading-[22px]">
            {t(`portalFlows.deleteGuard.title.${request.subject}`)}
          </AlertDialogTitle>
          <AlertDialogDescription className="text-start text-[13px] leading-[19px]">
            {t(`portalFlows.deleteGuard.description.${request.subject}`, {
              title: request.title,
              count: request.hosts.length
            })}
          </AlertDialogDescription>
          <ul className="flex flex-col gap-1.5 rounded-md bg-surface px-3 py-2.5">
            <HostRow>{t('portalFlows.deleteGuard.source', { title: request.sourceTitle })}</HostRow>
            {request.hosts.map((host) => (
              <HostRow key={host.noteId}>{host.title}</HostRow>
            ))}
          </ul>
          <AlertDialogFooter className="mt-1 gap-2 sm:space-x-0">
            {request.canRemoveHere ? (
              <AlertDialogCancel
                ref={removeRef}
                className="mt-0"
                onClick={(event) => {
                  event.preventDefault()
                  onChoose('here')
                }}
              >
                {t('portalFlows.deleteGuard.removeHere')}
              </AlertDialogCancel>
            ) : null}
            <AlertDialogCancel className="mt-0">
              {t('portalFlows.deleteGuard.cancel')}
            </AlertDialogCancel>
            <AlertDialogAction
              className={buttonVariants({ variant: 'destructive' })}
              onClick={() => {
                onChoose('everywhere')
              }}
            >
              {t('portalFlows.deleteGuard.everywhere')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      ) : null}
    </AlertDialog>
  )
}

function HostRow({ children }: { children: ReactNode }): ReactElement {
  return <li className="text-[13px] font-medium leading-4 text-foreground">{children}</li>
}

/**
 * `confirm(request)` opens the dialog and resolves with the answer. Render
 * `dialog` once, anywhere under the editor.
 */
export function usePortalDeleteConfirm(): {
  confirm: (request: PortalDeleteRequest) => Promise<PortalDeleteChoice>
  dialog: ReactElement
} {
  const [request, setRequest] = useState<PortalDeleteRequest | null>(null)
  const resolverRef = useRef<((choice: PortalDeleteChoice) => void) | null>(null)

  const confirm = useCallback((next: PortalDeleteRequest) => {
    // A second ask while one is open answers the first with a cancel.
    resolverRef.current?.('cancel')
    return new Promise<PortalDeleteChoice>((resolve) => {
      resolverRef.current = resolve
      setRequest(next)
    })
  }, [])

  const onChoose = useCallback((choice: PortalDeleteChoice) => {
    resolverRef.current?.(choice)
    resolverRef.current = null
    setRequest(null)
  }, [])

  return { confirm, dialog: <PortalDeleteDialog request={request} onChoose={onChoose} /> }
}
