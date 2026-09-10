import { AppText } from '@/components/ui/app-text'
import { describeNoteSaveStatus, type NoteSaveStatus } from '@/features/notes/save-status'
import { useColors } from '@/theme/use-colors'

/**
 * The note bar's status readout (#2115).
 *
 * It sits in `NavBarInline`'s `center` slot, which is `pointerEvents="none"` —
 * a readout, never a control — and the slot is free because the note screen's
 * heading is the display title below the bar, not the bar's own.
 *
 * Text, no glyph and no motion. A spinner would be the only animation on this
 * screen and would need a reduced-motion branch to earn its place; the word
 * carries the same meaning at rest, which is what DESIGN.md asks for.
 *
 * `accessible` merges the group into one element: a bare `View` wrapping
 * `Text` is not an accessibility element on iOS, so a label on it would never
 * reach VoiceOver (the sync banner makes the same call).
 */
export function NoteSaveStatusLabel({ status }: { status: NoteSaveStatus }) {
  const c = useColors()
  const described = describeNoteSaveStatus(status)
  if (!described) return null

  return (
    <AppText
      accessible
      testID="note-save-status"
      accessibilityRole="text"
      accessibilityLabel={described.accessibilityLabel}
      variant="footnote"
      color={c.text.secondary}
      numberOfLines={1}
    >
      {described.text}
    </AppText>
  )
}
