import { createPortal } from 'react-dom'
import { useHintModeContext } from '@/contexts/hint-mode'
import { HINT_OVERLAY_ID } from '@/lib/dom-scanner'
import { HintBadge } from './hint-badge'

export const HintOverlay = (): React.JSX.Element | null => {
  const { state } = useHintModeContext()

  if (!state.isActive) return null

  return createPortal(
    <div
      id={HINT_OVERLAY_ID}
      aria-hidden="true"
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 2147483646,
        pointerEvents: 'none'
      }}
    >
      {state.hints.map((hint, i) => (
        <HintBadge key={i} hint={hint} typedChars={state.typedChars} />
      ))}
    </div>,
    document.body
  )
}
