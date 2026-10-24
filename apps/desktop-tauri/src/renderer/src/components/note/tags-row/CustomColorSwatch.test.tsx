/**
 * CustomColorSwatch — native color-picker dismiss guard.
 *
 * The swatch wraps a native <input type="color">. Opening the OS color chooser
 * steals window focus; on close Chromium returns focus to <body>, which Radix
 * dismissable layers (Dialog / Popover / Menu) read as "focus outside" and use
 * to auto-dismiss — closing the host dialog mid-pick (the reported bug). The
 * swatch installs a capture-phase `focusin` guard that swallows that event
 * while its picker is open so no ancestor layer dismisses.
 *
 * Radix's own dismiss machinery listens via `document.addEventListener(
 * 'focusin', …)` (bubble phase); we assert the guard against a stand-in for
 * exactly that listener so the test is deterministic without a native picker.
 */
import { describe, it, expect, vi, beforeAll, afterEach } from 'vitest'
import { render, fireEvent } from '@testing-library/react'
import { I18nextProvider } from 'react-i18next'
import type { i18n as I18nInstance } from 'i18next'
import { createRendererI18n } from '@memry/i18n/renderer'
import { CustomColorSwatch } from './CustomColorSwatch'

let i18n: I18nInstance

beforeAll(async () => {
  i18n = await createRendererI18n({ locale: 'en' })
})

function renderSwatch(value = '', onChange = vi.fn()) {
  const utils = render(
    <I18nextProvider i18n={i18n}>
      <CustomColorSwatch value={value} onChange={onChange} />
    </I18nextProvider>
  )
  const input = utils.container.querySelector('input[type="color"]') as HTMLInputElement
  return { ...utils, input, onChange }
}

describe('CustomColorSwatch native picker dismiss guard', () => {
  // Mirrors Radix's dismissable-layer listener: a bubble-phase `focusin` on the
  // document is how it detects focus landing outside a layer and dismisses it.
  let radixDismiss: ReturnType<typeof vi.fn>
  afterEach(() => document.removeEventListener('focusin', radixDismiss))

  it('lets focusin reach the layer when the picker is closed (control)', () => {
    radixDismiss = vi.fn()
    document.addEventListener('focusin', radixDismiss)
    renderSwatch()

    fireEvent.focusIn(document.body)

    expect(radixDismiss).toHaveBeenCalledTimes(1)
  })

  it('swallows the focus-return focusin while the picker is open', () => {
    radixDismiss = vi.fn()
    document.addEventListener('focusin', radixDismiss)
    const { input } = renderSwatch()

    // The click that launches the OS color chooser arms the guard.
    fireEvent.click(input)
    // The OS picker closing returns focus to <body> — what Radix dismisses on.
    fireEvent.focusIn(document.body)

    expect(radixDismiss).not.toHaveBeenCalled()
  })

  it('forwards the chosen hex via onChange on commit (native change)', () => {
    const { input, onChange } = renderSwatch()

    fireEvent.change(input, { target: { value: '#ff0000' } })

    expect(onChange).toHaveBeenCalledWith('#ff0000')
  })

  // Live drag ticks (the DOM `input` event, which React's onChange mirrors) must
  // NOT commit — only the native `change` event on panel dismissal does. Else the
  // host re-renders mid-drag and unmounts the picker on the first move.
  it('does not commit on live input ticks while dragging', () => {
    const { input, onChange } = renderSwatch()

    fireEvent.input(input, { target: { value: '#00ff00' } })

    expect(onChange).not.toHaveBeenCalled()
  })
})
