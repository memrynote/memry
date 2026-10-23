import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { useT } from '@memry/i18n/renderer'
import { Button } from '@/components/ui/button'
import { getGoogleCalendarStatus } from '@/services/calendar-service'
import {
  GOOGLE_STATUS_QUERY_KEY,
  GoogleCalendarConnectDialog,
  GoogleIcon
} from './google-calendar-connect-dialog'

/**
 * Persistent "Connect Google Calendar" pill for the calendar toolbar. Renders
 * only while Google is disconnected; clicking it opens the connect dialog with
 * the three things Memry does with a linked calendar. Both vanish once
 * connected (status refetch flips `status.connected`).
 */
export function GoogleCalendarConnectPrompt(): React.JSX.Element | null {
  const { t } = useT('calendar')
  const [open, setOpen] = useState(false)

  const { data: status } = useQuery({
    queryKey: GOOGLE_STATUS_QUERY_KEY,
    queryFn: () => getGoogleCalendarStatus()
  })

  // Hidden entirely once a Google account is linked (and while status loads).
  if (status === undefined || status.connected) return null

  return (
    <>
      <Button
        type="button"
        variant="outline"
        size="sm"
        className="h-9 gap-1.5 rounded-lg px-3 text-xs font-medium"
        onClick={() => setOpen(true)}
      >
        <GoogleIcon />
        {t('connect-prompt.pill')}
      </Button>

      <GoogleCalendarConnectDialog open={open} onOpenChange={setOpen} />
    </>
  )
}

export default GoogleCalendarConnectPrompt
