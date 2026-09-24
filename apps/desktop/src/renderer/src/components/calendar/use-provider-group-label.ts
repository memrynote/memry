import { useT } from '@memry/i18n/renderer'

/** Heading for one provider's calendars in the calendar page filter (#1395). */
export function useProviderGroupLabel(): (provider: string) => string {
  const { t } = useT('calendar')
  return (provider) => {
    switch (provider) {
      case 'google':
        return t('filter.google-calendars')
      case 'ics':
        return t('filter.provider-calendars.ics')
      case 'caldav':
        return t('filter.provider-calendars.caldav')
      default:
        return t('filter.provider-calendars.other')
    }
  }
}
