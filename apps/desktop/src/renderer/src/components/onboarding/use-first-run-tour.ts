import { useEffect, useRef } from 'react'
import { driver, type DriveStep } from 'driver.js'
import 'driver.js/dist/driver.css'
import './tour.css'
import { useT } from '@memry/i18n/renderer'

export const TOUR_KEY = 'memry:onboarding:tour:v1'

/**
 * First-launch interactive tour. Runs at most once per install:
 * the flag is set when the tour finishes OR is skipped (both destroy it).
 *
 * Steps whose target element is not mounted are skipped automatically, so the
 * tour degrades gracefully when a surface is absent (AI disabled → no Agent
 * tab, the right Day Panel is closed, or a feature not present on this build).
 */
export function useFirstRunTour(): void {
  const { t } = useT('common')
  const startedRef = useRef(false)

  useEffect(() => {
    if (startedRef.current) return
    if (localStorage.getItem(TOUR_KEY)) return
    startedRef.current = true

    const prefersReducedMotion = matchMedia('(prefers-reduced-motion: reduce)').matches

    const steps: DriveStep[] = [
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
        element: '[data-tour="nav-inbox"]',
        popover: {
          title: t('onboarding.inbox.title'),
          description: t('onboarding.inbox.body'),
          side: 'right',
          align: 'start'
        }
      },
      {
        element: '[data-tour="nav-journal"]',
        popover: {
          title: t('onboarding.journal.title'),
          description: t('onboarding.journal.body'),
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
        element: '[data-tour="nav-tasks"]',
        popover: {
          title: t('onboarding.tasks.title'),
          description: t('onboarding.tasks.body'),
          side: 'right',
          align: 'start'
        }
      },
      {
        element: '[data-tour="sidebar-collections"]',
        popover: {
          title: t('onboarding.collections.title'),
          description: t('onboarding.collections.body'),
          side: 'right',
          align: 'start'
        }
      },
      {
        element: '[data-slot="day-panel-inner"]',
        popover: {
          title: t('onboarding.dayPanel.title'),
          description: t('onboarding.dayPanel.body'),
          side: 'left',
          align: 'start'
        }
      },
      {
        element: '[data-tour="rsb-agent"]',
        popover: {
          title: t('onboarding.agentChat.title'),
          description: t('onboarding.agentChat.body'),
          side: 'left',
          align: 'start'
        }
      },
      {
        element: '[data-tour="sync-status"]',
        popover: {
          title: t('onboarding.sync.title'),
          description: t('onboarding.sync.body'),
          side: 'top',
          align: 'start'
        }
      },
      {
        element: '[data-tour="feedback"]',
        popover: {
          title: t('onboarding.feedback.title'),
          description: t('onboarding.feedback.body'),
          side: 'top',
          align: 'start'
        }
      }
    ]

    const visibleSteps = steps.filter(
      (step) => typeof step.element !== 'string' || document.querySelector(step.element) !== null
    )

    const tour = driver({
      showProgress: true,
      animate: !prefersReducedMotion,
      allowClose: true,
      steps: visibleSteps,
      onDestroyed: () => {
        // ponytail: localStorage, app-wide once; move to a per-vault setting if we ever need to re-show per vault
        localStorage.setItem(TOUR_KEY, '1')
      }
    })

    tour.drive()
  }, [t])
}
