import { fireEvent, render, screen } from '@testing-library/react'
import { type ReactNode } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { HintModeProvider, useHintModeContext } from '@/contexts/hint-mode'
import { HINT_OVERLAY_ID } from '@/lib/dom-scanner'
import { HintBadge } from './hint-badge'
import { HintIndicator } from './hint-indicator'
import { HintOverlay } from './hint-overlay'

vi.mock('@memry/i18n/renderer', () => ({
  useT: () => ({
    t: (key: string) => key
  })
}))

const wrapper = ({ children }: { children: ReactNode }): React.JSX.Element => (
  <HintModeProvider>{children}</HintModeProvider>
)

const addTarget = (text: string, rect: Partial<DOMRect>): HTMLButtonElement => {
  const button = document.createElement('button')
  button.textContent = text
  button.getBoundingClientRect = () =>
    ({
      x: rect.x ?? 0,
      y: rect.y ?? 0,
      top: rect.top ?? 0,
      left: rect.left ?? 0,
      bottom: rect.bottom ?? 20,
      right: rect.right ?? 80,
      width: rect.width ?? 80,
      height: rect.height ?? 20,
      toJSON: () => ({})
    }) as DOMRect
  Object.defineProperty(button, 'offsetParent', { value: document.body, configurable: true })
  document.body.appendChild(button)
  return button
}

const Controls = (): React.JSX.Element => {
  const { activate, typeChar, deactivate } = useHintModeContext()
  return (
    <>
      <button type="button" onClick={activate}>
        activate
      </button>
      <button type="button" onClick={() => typeChar('I')}>
        type I
      </button>
      <button type="button" onClick={deactivate}>
        deactivate
      </button>
      <HintOverlay />
      <HintIndicator />
    </>
  )
}

describe('hint overlay components', () => {
  beforeEach(() => {
    document.body.innerHTML = ''
  })

  it('renders nothing while inactive, then portals hint badges and indicator', () => {
    addTarget('Inbox', { top: 4, left: 4 })
    addTarget('Journal', { top: 40, left: 120 })

    render(<Controls />, { wrapper })

    expect(document.getElementById(HINT_OVERLAY_ID)).toBeNull()
    expect(screen.queryByText('phaseF.componentsHintOverlayHintIndicator.hint')).toBeNull()

    fireEvent.click(screen.getByText('activate'))
    const overlay = document.getElementById(HINT_OVERLAY_ID)
    expect(overlay).toBeInTheDocument()
    expect(screen.getByText('phaseF.componentsHintOverlayHintIndicator.hint')).toBeInTheDocument()

    const inboxBadge = Array.from(overlay?.children ?? []).find(
      (child) => child.textContent === 'I'
    )
    expect(inboxBadge).toHaveStyle({ top: '0px', left: '0px', opacity: '1' })

    fireEvent.click(screen.getByText('deactivate'))
    expect(document.getElementById(HINT_OVERLAY_ID)).toBeNull()
  })

  it('dims non-matching badges and fades already typed characters', () => {
    const hint = {
      element: document.createElement('button'),
      label: 'AB',
      rect: {
        x: 0,
        y: 0,
        top: -10,
        left: 12,
        bottom: 20,
        right: 60,
        width: 60,
        height: 20,
        toJSON: () => ({})
      } as DOMRect
    }

    const { rerender } = render(<HintBadge hint={hint} typedChars="A" />)
    expect(screen.getByText('A')).toHaveStyle({ opacity: '0.4' })
    expect(screen.getByText('B')).toHaveStyle({ opacity: '1' })
    expect(screen.getByText('A').parentElement).toHaveStyle({
      top: '0px',
      left: '6px',
      opacity: '1'
    })

    rerender(<HintBadge hint={hint} typedChars="Z" />)
    expect(screen.getByText('A').parentElement).toHaveStyle({ opacity: '0.3' })
  })
})
