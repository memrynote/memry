import { describe, expect, it } from 'vitest'
import { CALENDAR_EVENT_COLORS } from '@memry/contracts/calendar-event-colors'

import { CALENDAR_EVENT_FILL_PERCENT } from '@/lib/calendar-event-colors'
import { AA_SMALL_TEXT, THEMES, blend, contrastRatio, resolveColor } from '@tests/utils/contrast'

/** WCAG 1.4.11 floor for a UI component that has to be seen, such as a swatch. */
const NON_TEXT = 3

describe.each(THEMES)('calendar event colours in %s', (theme) => {
  const background = resolveColor(theme, '--background')

  it.each(CALENDAR_EVENT_COLORS)('keeps a resting %s chip title at AA', (color) => {
    const fill = blend(
      resolveColor(theme, `--calendar-event-${color}`),
      background,
      CALENDAR_EVENT_FILL_PERCENT / 100
    )

    expect(contrastRatio(resolveColor(theme, '--foreground'), fill)).toBeGreaterThanOrEqual(
      AA_SMALL_TEXT
    )
  })

  it.each(CALENDAR_EVENT_COLORS)('keeps a selected %s chip title at AA', (color) => {
    const ratio = contrastRatio(
      resolveColor(theme, '--calendar-event-on-color'),
      resolveColor(theme, `--calendar-event-${color}`)
    )

    expect(ratio).toBeGreaterThanOrEqual(AA_SMALL_TEXT)
  })

  it.each(CALENDAR_EVENT_COLORS)('keeps the %s swatch visible on the popover', (color) => {
    const ratio = contrastRatio(
      resolveColor(theme, `--calendar-event-${color}`),
      resolveColor(theme, '--popover')
    )

    expect(ratio).toBeGreaterThanOrEqual(NON_TEXT)
  })
})
