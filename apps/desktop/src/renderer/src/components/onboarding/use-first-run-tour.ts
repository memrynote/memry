import { useEffect, useRef } from 'react'
import { driver } from 'driver.js'
import 'driver.js/dist/driver.css'
import './tour.css'
import { useT } from '@memry/i18n/renderer'

export const TOUR_KEY = 'memry:onboarding:tour:v1'

/**
 * First-launch interactive tour. Runs at most once per install:
 * the flag is set when the tour finishes OR is skipped (both destroy it).
 */
export function useFirstRunTour(): void {
  const { t } = useT('common')
  const startedRef = useRef(false)

  useEffect(() => {
    if (startedRef.current) return
    if (localStorage.getItem(TOUR_KEY)) return
    startedRef.current = true

    const prefersReducedMotion = matchMedia('(prefers-reduced-motion: reduce)').matches

    const tour = driver({
      showProgress: true,
      animate: !prefersReducedMotion,
      allowClose: true,
      steps: [
        {
          popover: {
            title: t('onboarding.welcome.title'),
            description: t('onboarding.welcome.body')
          }
        },
        {
          element: '[data-tour="new-note"]',
          popover: {
            title: t('onboarding.newNote.title'),
            description: t('onboarding.newNote.body'),
            side: 'right',
            align: 'start'
          }
        },
        {
          element: '[data-tour="sidebar-nav"]',
          popover: {
            title: t('onboarding.sidebarNav.title'),
            description: t('onboarding.sidebarNav.body'),
            side: 'right',
            align: 'start'
          }
        },
        {
          element: '[data-tour="nav-inbox"]',
          popover: {
            title: t('onboarding.inbox.title'),
            description: t('onboarding.inbox.body'),
            side: 'right',
            align: 'start'
          }
        },
        {
          element: '[data-tour="nav-calendar"]',
          popover: {
            title: t('onboarding.calendar.title'),
            description: t('onboarding.calendar.body'),
            side: 'right',
            align: 'start'
          }
        },
        {
          element: '[data-tour="settings"]',
          popover: {
            title: t('onboarding.settings.title'),
            description: t('onboarding.settings.body'),
            side: 'top',
            align: 'end'
          }
        }
      ],
      onDestroyed: () => {
        // localStorage, app-wide once; move to a per-vault setting if we ever need to re-show per vault
        localStorage.setItem(TOUR_KEY, '1')
      }
    })

    tour.drive()
  }, [t])
}
