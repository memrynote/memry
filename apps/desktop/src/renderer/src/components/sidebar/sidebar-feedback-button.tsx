import { useCallback, useState } from 'react'
import { toast } from 'sonner'

import { MessageCircle } from '@/lib/icons'
import { useT } from '@memry/i18n/renderer'
import { useAuth } from '@/contexts/auth-context'
import { useAppUpdater } from '@/hooks/use-app-updater'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/textarea'
import { createLogger } from '@/lib/logger'

const log = createLogger('Component:SidebarFeedbackButton')

/**
 * Ghost icon button in the sidebar footer (next to Settings) that opens a
 * lightweight feedback dialog. Message is required; email is optional and
 * auto-filled (hidden) when the user is signed in. Submissions are emailed to
 * the team with the sender as Reply-To. See main `feedback-handlers.ts`.
 */
export function SidebarFeedbackButton() {
  const { t } = useT('common')
  const { state: authState } = useAuth()
  const { state: updaterState } = useAppUpdater()

  const [open, setOpen] = useState(false)
  const [message, setMessage] = useState('')
  const [email, setEmail] = useState('')
  const [submitting, setSubmitting] = useState(false)

  const signedInEmail = authState.email
  const label = t('phaseF.componentsAppSidebar.feedbackButton')

  const handleSubmit = useCallback(async () => {
    const trimmed = message.trim()
    if (!trimmed || submitting) return

    setSubmitting(true)
    try {
      const result = await window.api.feedback.submit({
        message: trimmed,
        email: signedInEmail ?? (email.trim() || undefined),
        appVersion: updaterState.currentVersion,
        platform: navigator.platform || undefined
      })

      if (result.success) {
        toast.success(t('phaseF.componentsAppSidebar.feedbackSuccess'))
        setMessage('')
        setEmail('')
        setOpen(false)
      } else {
        toast.error(t('phaseF.componentsAppSidebar.feedbackError'))
      }
    } catch (err) {
      log.error('feedback submit failed', err)
      toast.error(t('phaseF.componentsAppSidebar.feedbackError'))
    } finally {
      setSubmitting(false)
    }
  }, [message, email, signedInEmail, submitting, updaterState.currentVersion, t])

  return (
    <>
      <Tooltip>
        <TooltipTrigger asChild>
          <button
            type="button"
            onClick={() => setOpen(true)}
            aria-label={label}
            title={label}
            className="shrink-0 size-7 rounded flex items-center justify-center hover:bg-sidebar-accent text-muted-foreground transition-colors"
          >
            <MessageCircle className="size-4" />
          </button>
        </TooltipTrigger>
        <TooltipContent side="top" className="text-xs">
          {label}
        </TooltipContent>
      </Tooltip>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>{t('phaseF.componentsAppSidebar.feedbackTitle')}</DialogTitle>
            <DialogDescription>
              {t('phaseF.componentsAppSidebar.feedbackDescription')}
            </DialogDescription>
          </DialogHeader>

          <div className="flex flex-col gap-3">
            <Textarea
              autoFocus
              value={message}
              onChange={(e) => setMessage(e.target.value)}
              placeholder={t('phaseF.componentsAppSidebar.feedbackPlaceholder')}
              maxLength={5000}
              className="min-h-[120px] resize-none"
            />

            {!signedInEmail && (
              <input
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder={t('phaseF.componentsAppSidebar.feedbackEmailHint')}
                className="flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
              />
            )}
          </div>

          <DialogFooter>
            <Button
              type="button"
              onClick={() => void handleSubmit()}
              disabled={!message.trim() || submitting}
            >
              {submitting
                ? t('phaseF.componentsAppSidebar.feedbackSending')
                : t('phaseF.componentsAppSidebar.feedbackSend')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  )
}
