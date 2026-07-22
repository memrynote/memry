import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle
} from '@/components/ui/alert-dialog'
import { Button } from '@/components/ui/button'
import { AlertTriangle } from '@/lib/icons'

interface SessionExpiredDialogProps {
  open: boolean
  onSignOut: () => void
}

/**
 * Shown when the server rejected this device's refresh token outright, so no
 * amount of retrying can revive the session. Without this the app sits in a
 * zombie signed-in state: the UI looks connected while sync is dead.
 *
 * Signing out is deliberately the user's click — the session is dead on the
 * server either way, but clearing local key material is not something to do
 * behind their back on the strength of an HTTP status.
 */
export function SessionExpiredDialog({
  open,
  onSignOut
}: SessionExpiredDialogProps): React.JSX.Element {
  return (
    <AlertDialog open={open}>
      <AlertDialogContent className="sm:max-w-md">
        <AlertDialogHeader>
          <div className="flex items-center gap-3 mb-1">
            <div className="flex items-center justify-center w-10 h-10 rounded-xl bg-amber-500/10 dark:bg-amber-400/10">
              <AlertTriangle
                className="w-5 h-5 text-amber-600 dark:text-amber-400"
                aria-hidden="true"
              />
            </div>
            <AlertDialogTitle className="font-display text-xl tracking-tight">
              {'Your session has ended'}
            </AlertDialogTitle>
          </div>
          <AlertDialogDescription className="font-serif text-[15px] leading-relaxed">
            {
              'This device has been signed out of your account, so syncing has stopped. Your notes on this device are untouched. Sign in again to resume syncing.'
            }
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <Button onClick={onSignOut}>{'Sign in again'}</Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}
