import { useCallback, useState } from 'react'
import { toast } from 'sonner'

import { MessageCircle } from '@/lib/icons'
import { useT } from '@memry/i18n/renderer'
import { useAuth } from '@/contexts/auth-context'
import { useAppUpdaterSelector } from '@/hooks/use-app-updater'
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
import { trackRendererError } from '@/lib/telemetry-diagnostics'

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
  // Only the version is needed here; reading the whole updater state re-rendered
  // this button (tooltip + dialog subtree) on every download-progress tick.
  const appVersion = useAppUpdaterSelector((state) => state.currentVersion)

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
        appVersion,
        platform: navigator.platform || undefined
      })

      if (result.success) {
        toast.success(t('phaseF.componentsAppSidebar.feedbackSuccess'))
        setMessage('')
        setEmail('')
        setOpen(false)
      } else {
        trackRendererError('feedback_submit_failed', (result as { error?: unknown }).error)
        toast.error(t('phaseF.componentsAppSidebar.feedbackError'))
      }
    } catch (err) {
      trackRendererError('feedback_submit_failed', err)
      log.error('feedback submit failed', err)
      toast.error(t('phaseF.componentsAppSidebar.feedbackError'))
    } finally {
      setSubmitting(false)
    }
  }, [message, email, signedInEmail, submitting, appVersion, t])

  return (
    <>
      <Tooltip>
        <TooltipTrigger asChild>
          <button
            type="button"
            data-tour="feedback"
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
                aria-label={t('phaseF.componentsAppSidebar.feedbackEmailHint')}
                placeholder={t('phaseF.componentsAppSidebar.feedbackEmailHint')}
                className="flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
              />
            )}

            <div className="rounded-md border border-border/60 bg-muted/40 px-3 py-2.5 text-xs text-muted-foreground">
              <p className="font-medium text-foreground/80">
                {t('phaseF.componentsAppSidebar.feedbackPrivacyTitle')}
              </p>
              <ul className="mt-1.5 flex list-disc flex-col gap-0.5 ps-4">
                <li>{t('phaseF.componentsAppSidebar.feedbackPrivacyMessage')}</li>
                <li>
                  {signedInEmail
                    ? t('phaseF.componentsAppSidebar.feedbackPrivacyEmailSignedIn', {
                        email: signedInEmail
                      })
                    : t('phaseF.componentsAppSidebar.feedbackPrivacyEmailOptional')}
                </li>
                <li>{t('phaseF.componentsAppSidebar.feedbackPrivacyVersion')}</li>
                {signedInEmail && <li>{t('phaseF.componentsAppSidebar.feedbackPrivacyPlan')}</li>}
              </ul>
              <p className="mt-1.5">{t('phaseF.componentsAppSidebar.feedbackPrivacyNote')}</p>
            </div>
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
