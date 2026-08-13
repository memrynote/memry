/**
 * Google-named entry point for the generic connect dialog. Kept so the
 * calendar toolbar pill and the agent composer's connected-tools tray keep
 * their import paths; the dialog itself branches on `authFlow` now.
 */
export {
  CalendarProviderConnectDialog as GoogleCalendarConnectDialog,
  GoogleIcon
} from './calendar-provider-connect-dialog'

export const GOOGLE_STATUS_QUERY_KEY = ['calendar', 'google', 'status'] as const
