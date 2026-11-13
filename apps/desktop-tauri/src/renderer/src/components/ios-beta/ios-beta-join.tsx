import { useState } from 'react'
import { toast } from 'sonner'

import type { IosBetaSource } from '@memry/contracts/ios-beta-api'
import { useT } from '@memry/i18n/renderer'
import { commands } from '../../../../generated/bindings'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '@/components/ui/dialog'
import { useAuth } from '@/contexts/auth-context'
import { createLogger } from '@/lib/logger'
import { trackRendererError } from '@/lib/telemetry-diagnostics'
import { markIosBetaJoined } from './ios-beta-store'

const log = createLogger('Component:IosBetaJoin')

// Apple logo glyph from simple-icons (CC0), 24x24 viewBox, like the community icons.
const APPLE_PATH =
  'M12.152 6.896c-.948 0-2.415-1.078-3.96-1.04-2.04.027-3.91 1.183-4.961 3.014-2.117 3.675-.546 9.103 1.519 12.09 1.013 1.454 2.208 3.09 3.792 3.039 1.52-.065 2.09-.987 3.935-.987 1.831 0 2.35.987 3.96.948 1.637-.026 2.676-1.48 3.676-2.948 1.156-1.688 1.636-3.325 1.662-3.415-.039-.013-3.182-1.221-3.22-4.857-.026-3.04 2.48-4.494 2.597-4.559-1.429-2.09-3.623-2.324-4.39-2.376-2-.156-3.675 1.09-4.61 1.09zM15.53 3.83c.843-1.012 1.4-2.427 1.245-3.83-1.207.052-2.662.805-3.532 1.818-.78.896-1.454 2.338-1.273 3.714 1.338.104 2.715-.688 3.559-1.701'

export function AppleGlyph({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true" className={className}>
      <path d={APPLE_PATH} />
    </svg>
  )
}

const INPUT_CLASS =
  'flex h-9 w-full min-w-0 rounded-md border border-input bg-background px-3 py-1 text-sm placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring'

interface IosBetaJoinFormProps {
  source: IosBetaSource
  /** Called with the address the invite went to. */
  onJoined: (email: string) => void
  children?: React.ReactNode
}

/**
 * Email field + submit for the iPhone TestFlight invite. Prefills the signed-in account's
 * email but leaves it editable: the invite must reach the Apple ID's inbox.
 */
function IosBetaJoinForm({ source, onJoined, children }: IosBetaJoinFormProps) {
  const { t } = useT('common')
  const { state: authState } = useAuth()
  const [email, setEmail] = useState(authState.email ?? '')
  const [submitting, setSubmitting] = useState(false)

  const handleSubmit = async () => {
    const trimmed = email.trim()
    if (!trimmed || submitting) return

    setSubmitting(true)
    try {
      const result = await commands.iosBetaJoin({ email: trimmed, source })
      if (result.success) {
        markIosBetaJoined(trimmed)
        onJoined(trimmed)
      } else {
        trackRendererError('ios_beta_join_failed', result.error)
        toast.error(t('iosBeta.error'))
      }
    } catch (error) {
      trackRendererError('ios_beta_join_failed', error)
      log.error('iPhone beta join failed', error)
      toast.error(t('iosBeta.error'))
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <form
      onSubmit={(event) => {
        event.preventDefault()
        void handleSubmit()
      }}
      className="flex flex-col gap-3"
    >
      <input
        type="email"
        required
        // oxlint-disable-next-line jsx-a11y/no-autofocus -- deliberate: the form lives only in the join dialog, which opens to type an email
        autoFocus
        value={email}
        onChange={(event) => setEmail(event.target.value)}
        placeholder={t('iosBeta.emailPlaceholder')}
        aria-label={t('iosBeta.emailLabel')}
        className={INPUT_CLASS}
      />
      {children}
      <Button type="submit" disabled={!email.trim() || submitting} className="self-end">
        {submitting ? t('iosBeta.sending') : t('iosBeta.submit')}
      </Button>
    </form>
  )
}

/** What to do next once Apple has the address. */
function IosBetaSentSteps({ email }: { email: string }) {
  const { t } = useT('common')
  return (
    <div className="flex flex-col gap-3">
      <p className="text-sm text-muted-foreground">{t('iosBeta.sentBody', { email })}</p>
      <ol className="flex list-decimal flex-col gap-1 rounded-md bg-muted/50 px-3 py-2.5 ps-7 text-xs text-muted-foreground">
        <li>{t('iosBeta.stepInstall')}</li>
        <li>{t('iosBeta.stepOpen')}</li>
        <li>{t('iosBeta.stepSignIn')}</li>
      </ol>
    </div>
  )
}

interface IosBetaDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  source: IosBetaSource
}

/** The join modal. The one-time launch prompt announces the beta; the other entries just ask. */
export function IosBetaDialog({ open, onOpenChange, source }: IosBetaDialogProps) {
  const isPrompt = source === 'launch_prompt'
  const { t } = useT('common')
  const [sentTo, setSentTo] = useState<string | null>(null)

  const handleOpenChange = (next: boolean) => {
    if (!next) setSentTo(null)
    onOpenChange(next)
  }

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="sm:max-w-sm">
        {sentTo ? (
          <>
            <DialogHeader>
              <DialogTitle>{t('iosBeta.sentTitle')}</DialogTitle>
              <DialogDescription className="sr-only">
                {t('iosBeta.sentBody', { email: sentTo })}
              </DialogDescription>
            </DialogHeader>
            <IosBetaSentSteps email={sentTo} />
            <DialogFooter>
              <Button type="button" onClick={() => handleOpenChange(false)}>
                {t('iosBeta.done')}
              </Button>
            </DialogFooter>
          </>
        ) : (
          <>
            <DialogHeader>
              <span className="flex size-10 items-center justify-center rounded-lg bg-muted text-foreground">
                <AppleGlyph className="size-5" />
              </span>
              {isPrompt && (
                <span className="text-[11px] font-semibold tracking-wider text-tint uppercase">
                  {t('iosBeta.badge')}
                </span>
              )}
              <DialogTitle>{isPrompt ? t('iosBeta.title') : t('iosBeta.dialogTitle')}</DialogTitle>
              <DialogDescription>
                {isPrompt ? t('iosBeta.promptBody') : t('iosBeta.dialogBody')}
              </DialogDescription>
            </DialogHeader>
            <IosBetaJoinForm source={source} onJoined={setSentTo}>
              <p className="text-xs text-muted-foreground">{t('iosBeta.listNote')}</p>
            </IosBetaJoinForm>
          </>
        )}
      </DialogContent>
    </Dialog>
  )
}
