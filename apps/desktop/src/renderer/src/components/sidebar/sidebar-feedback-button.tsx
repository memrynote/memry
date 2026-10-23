import { useCallback, useState } from 'react'
import { toast } from 'sonner'

import { ArrowUpRight, Bug, Lightbulb, MessageCircle, MessageSquare, Star } from '@/lib/icons'
import { COMMUNITY_LINKS } from '@memry/contracts/community-links'
import { useT } from '@memry/i18n/renderer'
import { useAuth } from '@/contexts/auth-context'
import { useAppUpdaterSelector } from '@/hooks/use-app-updater'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'
import { DockButton } from '@/components/sidebar/footer-dock'
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

const REPO_URL = 'https://github.com/memrynote/memry'
const BUG_URL = `${REPO_URL}/issues/new?template=bug.yml`
const FEATURE_URL = `${REPO_URL}/issues/new?template=feature.yml`
const RELEASES_URL = `${REPO_URL}/releases/latest`

// Official brand glyphs from simple-icons (CC0), 24x24 viewBox, same as the landing footer.
const COMMUNITY_ITEMS = [
  {
    key: 'joinDiscord',
    href: COMMUNITY_LINKS.discord,
    path: 'M20.317 4.3698a19.7913 19.7913 0 00-4.8851-1.5152.0741.0741 0 00-.0785.0371c-.211.3753-.4447.8648-.6083 1.2495-1.8447-.2762-3.68-.2762-5.4868 0-.1636-.3933-.4058-.8742-.6177-1.2495a.077.077 0 00-.0785-.037 19.7363 19.7363 0 00-4.8852 1.515.0699.0699 0 00-.0321.0277C.5334 9.0458-.319 13.5799.0992 18.0578a.0824.0824 0 00.0312.0561c2.0528 1.5076 4.0413 2.4228 5.9929 3.0294a.0777.0777 0 00.0842-.0276c.4616-.6304.8731-1.2952 1.226-1.9942a.076.076 0 00-.0416-.1057c-.6528-.2476-1.2743-.5495-1.8722-.8923a.077.077 0 01-.0076-.1277c.1258-.0943.2517-.1923.3718-.2914a.0743.0743 0 01.0776-.0105c3.9278 1.7933 8.18 1.7933 12.0614 0a.0739.0739 0 01.0785.0095c.1202.099.246.1981.3728.2924a.077.077 0 01-.0066.1276 12.2986 12.2986 0 01-1.873.8914.0766.0766 0 00-.0407.1067c.3604.698.7719 1.3628 1.225 1.9932a.076.076 0 00.0842.0286c1.961-.6067 3.9495-1.5219 6.0023-3.0294a.077.077 0 00.0313-.0552c.5004-5.177-.8382-9.6739-3.5485-13.6604a.061.061 0 00-.0312-.0286zM8.02 15.3312c-1.1825 0-2.1569-1.0857-2.1569-2.419 0-1.3332.9555-2.4189 2.157-2.4189 1.2108 0 2.1757 1.0952 2.1568 2.419 0 1.3332-.9555 2.4189-2.1569 2.4189zm7.9748 0c-1.1825 0-2.1569-1.0857-2.1569-2.419 0-1.3332.9554-2.4189 2.1569-2.4189 1.2108 0 2.1757 1.0952 2.1568 2.419 0 1.3332-.946 2.4189-2.1568 2.4189Z'
  },
  {
    key: 'followOnX',
    href: COMMUNITY_LINKS.x,
    path: 'M14.234 10.162 22.977 0h-2.072l-7.591 8.824L7.251 0H.258l9.168 13.343L.258 24H2.33l8.016-9.318L16.749 24h6.993zm-2.837 3.299-.929-1.329L3.076 1.56h3.182l5.965 8.532.929 1.329 7.754 11.09h-3.182z'
  },
  {
    key: 'redditCommunity',
    href: COMMUNITY_LINKS.reddit,
    path: 'M12 0C5.373 0 0 5.373 0 12c0 3.314 1.343 6.314 3.515 8.485l-2.286 2.286C.775 23.225 1.097 24 1.738 24H12c6.627 0 12-5.373 12-12S18.627 0 12 0Zm4.388 3.199c1.104 0 1.999.895 1.999 1.999 0 1.105-.895 2-1.999 2-.946 0-1.739-.657-1.947-1.539v.002c-1.147.162-2.032 1.15-2.032 2.341v.007c1.776.067 3.4.567 4.686 1.363.473-.363 1.064-.58 1.707-.58 1.547 0 2.802 1.254 2.802 2.802 0 1.117-.655 2.081-1.601 2.531-.088 3.256-3.637 5.876-7.997 5.876-4.361 0-7.905-2.617-7.998-5.87-.954-.447-1.614-1.415-1.614-2.538 0-1.548 1.255-2.802 2.803-2.802.645 0 1.239.218 1.712.585 1.275-.79 2.881-1.291 4.64-1.365v-.01c0-1.663 1.263-3.034 2.88-3.207.188-.911.993-1.595 1.959-1.595Zm-8.085 8.376c-.784 0-1.459.78-1.506 1.797-.047 1.016.64 1.429 1.426 1.429.786 0 1.371-.369 1.418-1.385.047-1.017-.553-1.841-1.338-1.841Zm7.406 0c-.786 0-1.385.824-1.338 1.841.047 1.017.634 1.385 1.418 1.385.785 0 1.473-.413 1.426-1.429-.046-1.017-.721-1.797-1.506-1.797Zm-3.703 4.013c-.974 0-1.907.048-2.77.135-.147.015-.241.168-.183.305.483 1.154 1.622 1.964 2.953 1.964 1.33 0 2.47-.81 2.953-1.964.057-.137-.037-.29-.184-.305-.863-.087-1.795-.135-2.769-.135Z'
  }
] as const

/** Routed to the OS browser by the main-process openExternal allowlist. */
function openExternal(url: string): void {
  window.open(url, '_blank', 'noopener,noreferrer')
}

/**
 * Help button in the sidebar footer dock. Opens a menu: in-app feedback, GitHub
 * bug / feature issue templates, community channels, and the repo star link. The open-source ask
 * lives here because the user opened the menu themselves.
 *
 * "Send feedback" opens a lightweight feedback dialog. Message is required; email is optional and
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
  const helpLabel = t('sidebarHelp.label')

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
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <DockButton data-tour="feedback" aria-label={helpLabel} title={helpLabel}>
            <MessageCircle aria-hidden="true" />
          </DockButton>
        </DropdownMenuTrigger>
        <DropdownMenuContent side="top" align="end" sideOffset={8} className="w-56">
          <DropdownMenuItem
            onSelect={() => {
              setOpen(true)
            }}
          >
            <MessageSquare aria-hidden="true" />
            {label}
          </DropdownMenuItem>
          <DropdownMenuItem
            onSelect={() => {
              openExternal(BUG_URL)
            }}
          >
            <Bug aria-hidden="true" />
            <span className="flex-1">{t('sidebarHelp.reportBug')}</span>
            <ArrowUpRight aria-hidden="true" className="text-text-tertiary" />
          </DropdownMenuItem>
          <DropdownMenuItem
            onSelect={() => {
              openExternal(FEATURE_URL)
            }}
          >
            <Lightbulb aria-hidden="true" />
            <span className="flex-1">{t('sidebarHelp.requestFeature')}</span>
            <ArrowUpRight aria-hidden="true" className="text-text-tertiary" />
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          {COMMUNITY_ITEMS.map((item) => (
            <DropdownMenuItem
              key={item.key}
              onSelect={() => {
                openExternal(item.href)
              }}
            >
              <svg viewBox="0 0 24 24" aria-hidden="true" className="fill-current">
                <path d={item.path} />
              </svg>
              <span className="flex-1">{t(`sidebarHelp.${item.key}`)}</span>
              <ArrowUpRight aria-hidden="true" className="text-text-tertiary" />
            </DropdownMenuItem>
          ))}
          <DropdownMenuSeparator />
          <DropdownMenuItem
            onSelect={() => {
              openExternal(REPO_URL)
            }}
          >
            <Star aria-hidden="true" className="text-[var(--tint)]" />
            <span className="flex-1">{t('sidebarHelp.starOnGithub')}</span>
            <ArrowUpRight aria-hidden="true" className="text-text-tertiary" />
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <div className="flex items-center justify-between px-2 py-1 font-mono text-[10.5px] text-text-tertiary">
            <span>{t('sidebarHelp.version', { version: appVersion })}</span>
            <button
              type="button"
              onClick={() => {
                openExternal(RELEASES_URL)
              }}
              className="rounded hover:text-text-secondary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--tint-ring)]"
            >
              {t('sidebarHelp.whatsNew')}
            </button>
          </div>
        </DropdownMenuContent>
      </DropdownMenu>

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
              onChange={(e) => {
                setMessage(e.target.value)
              }}
              placeholder={t('phaseF.componentsAppSidebar.feedbackPlaceholder')}
              maxLength={5000}
              className="min-h-[120px] resize-none"
            />

            {!signedInEmail && (
              <input
                type="email"
                value={email}
                onChange={(e) => {
                  setEmail(e.target.value)
                }}
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
