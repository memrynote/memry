import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'

import { useT } from '@memry/i18n/renderer'

import {
  GOOGLE_STATUS_QUERY_KEY,
  GoogleCalendarConnectDialog
} from '@/components/calendar/google-calendar-connect-dialog'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'
import { Plug } from '@/lib/icons'
import { getGoogleCalendarStatus } from '@/services/calendar-service'

const GOOGLE_CALENDAR_NAME = 'Google Calendar'

/**
 * Google Calendar brand mark, drawn inline so it stays crisp at 16px and needs
 * no bundled binary. Proportions follow the 2020 logo: white sheet, blue top +
 * left frame, yellow right column, green bottom row, red corner fold.
 */
function GoogleCalendarIcon({ className }: { className?: string }): React.JSX.Element {
  return (
    <svg className={className} viewBox="0 0 24 24" aria-hidden="true">
      <path fill="#ffffff" d="M18.3 5.7H5.7v12.6h12.6z" />
      <path fill="#ea4335" d="M18.3 24 24 18.3h-5.7z" />
      <path fill="#fbbc04" d="M24 5.7h-5.7v12.6H24z" />
      <path fill="#34a853" d="M18.3 18.3H5.7V24h12.6z" />
      <path fill="#188038" d="M0 18.3v3.3c0 1.3 1.1 2.4 2.4 2.4h3.3v-5.7z" />
      <path fill="#1967d2" d="M24 5.7V2.4C24 1.1 22.9 0 21.6 0h-3.3v5.7z" />
      <path fill="#4285f4" d="M18.3 0H2.4A2.4 2.4 0 0 0 0 2.4v15.9h5.7V5.7h12.6z" />
      <text
        x="12"
        y="15.6"
        fill="#4285f4"
        fontFamily="Inter, system-ui, sans-serif"
        fontSize="9"
        fontWeight="600"
        textAnchor="middle"
      >
        31
      </text>
    </svg>
  )
}

/**
 * Tray that peeks out from under the composer card. It exists only to offer the
 * one integration the agent can still gain, so it disappears for good once
 * Google Calendar is linked (the shared status query keeps it in sync with the
 * calendar surfaces).
 */
export function ConnectedToolsTray(): React.JSX.Element | null {
  const { t } = useT('common')
  const [connectOpen, setConnectOpen] = useState(false)

  const { data: status } = useQuery({
    queryKey: GOOGLE_STATUS_QUERY_KEY,
    queryFn: () => getGoogleCalendarStatus()
  })

  if (status === undefined || status.connected) return null

  return (
    <div className="absolute inset-x-2 bottom-0 flex h-[76px] items-end justify-between rounded-2xl border border-border bg-card/60 px-2 pb-2.5">
      <div className="flex h-[18px] min-w-0 items-center gap-2 ps-1">
        <Plug className="size-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
        <span className="truncate text-[13px] leading-[18px] text-muted-foreground">
          {t('agentChat.composer.connectedTools')}
        </span>
      </div>
      <TooltipProvider delayDuration={200}>
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              type="button"
              aria-label={t('agentChat.composer.connectTool', { tool: GOOGLE_CALENDAR_NAME })}
              onClick={() => setConnectOpen(true)}
              className="inline-flex h-[18px] w-[18px] shrink-0 items-center justify-center rounded-sm transition-opacity hover:opacity-75 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
            >
              <GoogleCalendarIcon className="size-3.5" />
            </button>
          </TooltipTrigger>
          <TooltipContent side="top" className="text-xs">
            {GOOGLE_CALENDAR_NAME}
          </TooltipContent>
        </Tooltip>
      </TooltipProvider>

      <GoogleCalendarConnectDialog open={connectOpen} onOpenChange={setConnectOpen} />
    </div>
  )
}
