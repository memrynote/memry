import { useEffect } from 'react'
import { driver, type DriveStep, type Driver } from 'driver.js'
import 'driver.js/dist/driver.css'
import './tour.css'
import { useT } from '@memry/i18n/renderer'
import { useDayPanel } from '@/contexts/day-panel-context'
import { STAR_PROMPT_EVENT, STAR_PROMPT_KEY } from './star-prompt'

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
  const { open: openDayPanel } = useDayPanel()

  // Mount-scoped on purpose. The effect owns a live driver.js instance, so it
  // must not be torn down and rebuilt just because react-i18next handed back a
  // new `t` (it does on a language change): that would restart a running tour
  // from step 1. The labels the tour needs are read once, when it is built.
  useEffect(() => {
    if (localStorage.getItem(TOUR_KEY)) return

    // driver.js appends an overlay <svg> to <body> and attaches its own
    // resize/scroll/keydown listeners; only destroy() takes those back down.
    let tour: Driver | undefined
    // Set by the cleanup so onDestroyed can tell an unmount-driven teardown from
    // the user finishing, skipping, or closing the tour.
    let unmounted = false

    // Open the right Day Panel so its calendar + Agent steps have live targets,
    // even for returning users whose saved layout has it closed.
    openDayPanel()

    const prefersReducedMotion = matchMedia('(prefers-reduced-motion: reduce)').matches

    // Drive the right Day Panel's tabs by clicking the real tab buttons, so the
    // tour reuses the app's own handlers instead of reaching into tab state.
    const clickTourTarget = (selector: string): void => {
      const el = document.querySelector(selector)
      if (el instanceof HTMLElement) el.click()
    }

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
        element: '[data-tour="sidebar-nav"]',
        popover: {
          title: t('onboarding.nav.title'),
          description: t('onboarding.nav.body'),
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
        // Make sure the calendar (day) tab is showing for this step.
        onHighlightStarted: () => clickTourTarget('[data-tour="rsb-day"]'),
        popover: {
          title: t('onboarding.dayPanel.title'),
          description: t('onboarding.dayPanel.body'),
          side: 'left',
          align: 'start'
        }
      },
      {
        element: '[data-tour="rsb-agent"]',
        // Open the Agent tab while this step is shown, then restore the calendar
        // (day) tab as the default resting state when leaving the step.
        onHighlightStarted: () => clickTourTarget('[data-tour="rsb-agent"]'),
        onDeselected: () => clickTourTarget('[data-tour="rsb-day"]'),
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
    ]

    // driver.js's progress counter is a template written in driver.js's OWN
    // placeholder syntax — double braces, substituted by a plain string replace
    // inside the library. That is NOT i18next/ICU syntax: IntlMessageFormat
    // cannot parse `{{`, and IcuFormatter swallows the parse error and returns
    // the raw template, so double braces in a locale message fail *silently*.
    // Instead the message uses ordinary ICU single-brace placeholders and we
    // hand the driver.js tokens in as literal *values*: ICU only ever parses
    // `{current} of {total}` and emits `{{current}} of {{total}}`, which driver.js
    // then fills in. Translators can still reorder the two placeholders.
    const localizedProgress = t('onboarding.tour.progress', {
      current: '{{current}}',
      total: '{{total}}'
    })

    // driver.js substitutes with a non-global, literal `.replace()` per token, so
    // each one has to survive translation exactly once. A locale that drops a
    // token loses that number; one that repeats it prints a raw `{{current}}`;
    // one that quotes it away (ICU reads a lone apostrophe as a quote, so
    // `d'{total}` eats the placeholder) does both. Fall back to a language-neutral
    // counter rather than showing a raw template to the user.
    const appearsOnce = (value: string, token: string): boolean => value.split(token).length === 2
    const progressText =
      appearsOnce(localizedProgress, '{{current}}') && appearsOnce(localizedProgress, '{{total}}')
        ? localizedProgress
        : '{{current}} / {{total}}'

    // Defer one frame so the just-opened Day Panel has mounted before we test
    // for each step's target element.
    const frame = requestAnimationFrame(() => {
      const visibleSteps = steps.filter(
        (step) => typeof step.element !== 'string' || document.querySelector(step.element) !== null
      )

      tour = driver({
        showProgress: true,
        progressText,
        nextBtnText: t('onboarding.tour.next'),
        prevBtnText: t('onboarding.tour.previous'),
        doneBtnText: t('button.done'),
        animate: !prefersReducedMotion,
        allowClose: true,
        steps: visibleSteps,
        // driver.js builds its ✕ button with a hardcoded English aria-label, and
        // that button is the tour's only dismiss affordance. This typed hook runs
        // once the popover DOM exists, which is the sole place to localize it.
        onPopoverRender: (popover) => {
          popover.closeButton.setAttribute('aria-label', t('button.close'))
        },
        onDestroyed: () => {
          // destroy() also runs on unmount, and that is not the user answering:
          // leave the flag and the star prompt untouched so the tour still gets
          // its one run, exactly as it did before this cleanup existed.
          if (unmounted) return
          // ponytail: localStorage, app-wide once; move to a per-vault setting if we ever need to re-show per vault
          localStorage.setItem(TOUR_KEY, '1')
          // The tour lands here however it ended — finished, skipped, or closed —
          // so the star prompt is armed here too. Arm it only while unset: once
          // the user has answered ('done'), never ask again.
          if (!localStorage.getItem(STAR_PROMPT_KEY)) {
            localStorage.setItem(STAR_PROMPT_KEY, 'pending')
            window.dispatchEvent(new Event(STAR_PROMPT_EVENT))
          }
        }
      })

      tour.drive()
    })

    return () => {
      unmounted = true
      cancelAnimationFrame(frame)
      tour?.destroy()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- mount-scoped, see above
  }, [])
}
