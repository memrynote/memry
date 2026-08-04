import { getMainI18n } from '../../lib/main-i18n'

export function userMessageForTokenEndpointError(args: {
  status: number
  errorCode?: string
  errorDescription?: string
}): string {
  const t = getMainI18n().getFixedT(null, 'errors')
  const desc = (args.errorDescription ?? '').toLowerCase()

  switch (args.errorCode) {
    case 'invalid_grant':
      return t('googleCalendar.reconnectNeeded')
    case 'access_denied':
      return t('googleCalendar.accessDenied')
    case 'invalid_client':
    case 'unauthorized_client':
    case 'unsupported_grant_type':
      return t('googleCalendar.misconfigured')
    case 'invalid_request':
      if (desc.includes('client_secret') || desc.includes('code_verifier')) {
        return t('googleCalendar.misconfigured')
      }
      return t('googleCalendar.connectFailed')
  }

  if (args.status >= 500) {
    return t('googleCalendar.temporarilyUnavailable')
  }
  return t('googleCalendar.connectFailed')
}

export function userMessageForCalendarApiError(args: {
  status: number
  apiStatus?: string
}): string {
  const t = getMainI18n().getFixedT(null, 'errors')

  if (args.status === 401) {
    return t('googleCalendar.reconnectNeeded')
  }
  if (args.status === 403 || args.apiStatus === 'PERMISSION_DENIED') {
    return t('googleCalendar.scopeMissing')
  }
  if (args.status >= 500) {
    return t('googleCalendar.temporarilyUnavailable')
  }
  return t('googleCalendar.connectFailed')
}

export function calendarScopeNotGrantedMessage(): string {
  const t = getMainI18n().getFixedT(null, 'errors')
  return t('googleCalendar.scopeMissing')
}
