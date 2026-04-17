const GENERIC_CONNECT_FAILURE = "Couldn't connect to Google Calendar. Please try again in a moment."

const RECONNECT_NEEDED =
  'Your Google Calendar connection has expired. Please disconnect and connect again.'

const MISCONFIGURED =
  'Google Calendar is not configured correctly. Please contact support if this keeps happening.'

const CALENDAR_SCOPE_MISSING =
  "We couldn't access your Google Calendar because Calendar permission wasn't granted. Please try again and make sure the Calendar checkbox stays ticked on the Google consent screen."

const ACCESS_DENIED =
  'Google Calendar access was declined. You can connect again whenever you are ready.'

const TRANSIENT_UPSTREAM = 'Google Calendar is temporarily unavailable. Please try again shortly.'

export function userMessageForTokenEndpointError(args: {
  status: number
  errorCode?: string
  errorDescription?: string
}): string {
  const desc = (args.errorDescription ?? '').toLowerCase()

  switch (args.errorCode) {
    case 'invalid_grant':
      return RECONNECT_NEEDED
    case 'access_denied':
      return ACCESS_DENIED
    case 'invalid_client':
    case 'unauthorized_client':
    case 'unsupported_grant_type':
      return MISCONFIGURED
    case 'invalid_request':
      if (desc.includes('client_secret') || desc.includes('code_verifier')) {
        return MISCONFIGURED
      }
      return GENERIC_CONNECT_FAILURE
  }

  if (args.status >= 500) {
    return TRANSIENT_UPSTREAM
  }
  return GENERIC_CONNECT_FAILURE
}

export function userMessageForCalendarApiError(args: {
  status: number
  apiStatus?: string
}): string {
  if (args.status === 401) {
    return RECONNECT_NEEDED
  }
  if (args.status === 403 || args.apiStatus === 'PERMISSION_DENIED') {
    return CALENDAR_SCOPE_MISSING
  }
  if (args.status >= 500) {
    return TRANSIENT_UPSTREAM
  }
  return GENERIC_CONNECT_FAILURE
}

export const CALENDAR_SCOPE_NOT_GRANTED_MESSAGE = CALENDAR_SCOPE_MISSING
