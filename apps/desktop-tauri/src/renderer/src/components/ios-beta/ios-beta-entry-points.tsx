import { useState } from 'react'

import { useT } from '@memry/i18n/renderer'
import { useFirstRunWizardActive } from '@/components/onboarding-wizard/first-run-store'
import { AppleGlyph, IosBetaDialog } from './ios-beta-join'
import { markIosBetaPromptSeen, useIosBetaState } from './ios-beta-store'

/**
 * One-time announcement modal. Opens on the first launch with a vault open after this
 * build lands, and never again once closed (or once the user joined). Later joins go
 * through the Settings entry and the help menu.
 */
export function IosBetaLaunchPrompt() {
  const { joinedEmail, promptSeen } = useIosBetaState()
  const firstRunActive = useFirstRunWizardActive()
  // Decided at mount: joining inside the prompt keeps it open on the "check your inbox" step.
  const [alreadyJoined] = useState(() => joinedEmail !== null)

  if (alreadyJoined || promptSeen || firstRunActive) return null

  return (
    <IosBetaDialog
      open
      onOpenChange={(next) => {
        if (!next) markIosBetaPromptSeen()
      }}
      source="launch_prompt"
    />
  )
}

/** Bottom of the Settings nav, on every settings page. */
export function IosBetaSettingsEntry() {
  const { t } = useT('common')
  const { joinedEmail } = useIosBetaState()
  const [open, setOpen] = useState(false)

  return (
    <div className="shrink-0 px-3 pb-3">
      <div className="flex flex-col gap-2.5 rounded-[10px] border border-border bg-background p-3">
        <div className="flex items-center gap-2.5">
          <span className="flex size-7 shrink-0 items-center justify-center rounded-md bg-sidebar-accent text-sidebar-primary">
            <AppleGlyph className="size-4" />
          </span>
          <div className="flex min-w-0 flex-col">
            <span className="truncate text-[13px]/4 font-medium text-sidebar-primary">
              {t('iosBeta.entryTitle')}
            </span>
            <span className="truncate text-[11px]/4 text-sidebar-foreground">
              {joinedEmail
                ? t('iosBeta.entrySent', { email: joinedEmail })
                : t('iosBeta.entrySubtitle')}
            </span>
          </div>
        </div>
        <button
          type="button"
          onClick={() => setOpen(true)}
          className={
            joinedEmail
              ? 'h-7 rounded-[7px] text-[12px] text-sidebar-foreground transition-colors hover:bg-sidebar-accent hover:text-sidebar-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sidebar-primary'
              : 'h-7 rounded-[7px] bg-foreground text-[12px] font-medium text-background transition-opacity hover:opacity-90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sidebar-primary'
          }
        >
          {joinedEmail ? t('iosBeta.sendAgain') : t('iosBeta.entryJoin')}
        </button>
      </div>
      <IosBetaDialog open={open} onOpenChange={setOpen} source="settings" />
    </div>
  )
}
