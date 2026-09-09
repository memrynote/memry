import { useCallback, useRef, useState } from 'react'
import { InteractionManager, Platform, Pressable, StyleSheet, View } from 'react-native'
import Animated, {
  Easing,
  useAnimatedStyle,
  useSharedValue,
  withSpring,
  withTiming
} from 'react-native-reanimated'
import { useSafeAreaInsets } from 'react-native-safe-area-context'

import { AppText } from '@/components/ui/app-text'
import { BottomSheet } from '@/components/ui/bottom-sheet'
import { Icon, type IconName } from '@/components/ui/icon'
import type { Color } from '@/theme/colors'
import { radius, space } from '@/theme/primitives'
import { useColors } from '@/theme/use-colors'
import { removeTag, setNoteTags, type NoteOpsContext } from './note-ops'
import { useTagColors } from './use-tag-colors'

/**
 * The inline tag row (board 33).
 *
 * Case-PRESERVING, case-insensitive: what the user typed is what is stored,
 * and `Roadmap` cannot be added twice as `roadmap`. Matching desktop here is
 * not cosmetic — a mobile edit that lower-cased tags would rewrite them for
 * every device on the next sync.
 *
 * The row is stateless. A tap on a chip is navigation — it opens the vault's
 * notes carrying that tag — and a long press opens the chip's action sheet,
 * which is where removal lives. The row used to arm an editing state on the
 * first tap and remove on the second, with a 14pt badge as the only hint; two
 * taps to reach a target that small is not a gesture anyone finds.
 */
export interface NoteTagsProps {
  ctx: NoteOpsContext | null
  noteId: string
  tags: string[]
  readOnly: boolean
  /** Show every note carrying this tag. */
  onOpenTag: (tag: string) => void
  onChanged: (tags: string[]) => void
}

export function NoteTags({ ctx, noteId, tags, readOnly, onOpenTag, onChanged }: NoteTagsProps) {
  const resolveColor = useTagColors(ctx?.db ?? null)
  const [menuTag, setMenuTag] = useState<string | null>(null)

  const commit = useCallback(
    async (next: string[]) => {
      onChanged(next)
      if (ctx) await setNoteTags(ctx, noteId, next)
    },
    [ctx, noteId, onChanged]
  )

  if (tags.length === 0) return null

  return (
    <View style={styles.row}>
      {tags.map((tag) => {
        const hue = resolveColor(tag)
        return (
          <TagChip
            key={tag}
            tag={tag}
            fill={hue.fill}
            textColor={hue.text}
            onPress={() => onOpenTag(tag)}
            onLongPress={readOnly ? undefined : () => setMenuTag(tag)}
          />
        )
      })}

      <TagActionSheet
        tag={menuTag}
        onClose={() => setMenuTag(null)}
        onOpen={onOpenTag}
        onRemove={(tag) => void commit(removeTag(tags, tag))}
      />
    </View>
  )
}

/**
 * How long a press has to be held before the action sheet opens.
 *
 * Shorter than RN's 500ms default, matching `TreeRow`: the sheet is the chip's
 * only route to removal, so it has to feel like a shortcut rather than a wait.
 */
const LONG_PRESS_MS = 350

/**
 * One tag chip, with a press that shows its own progress.
 *
 * A long press with no feedback is invisible — the finger is down, nothing
 * moves, and the user lets go before the gesture ever fires. So the chip
 * shrinks over exactly `LONG_PRESS_MS`, reaching its smallest at the moment
 * the sheet opens: the animation *is* the progress bar. Releasing early
 * springs it back, which reads as "not yet" instead of "nothing happened".
 */
function TagChip({
  tag,
  fill,
  textColor,
  onPress,
  onLongPress
}: {
  tag: string
  fill: Color
  textColor: Color
  onPress: () => void
  onLongPress?: () => void
}) {
  const progress = useSharedValue(0)
  const animatedStyle = useAnimatedStyle(() => ({
    transform: [{ scale: 1 - progress.value * 0.08 }],
    opacity: 1 - progress.value * 0.25
  }))

  const release = (): void => {
    progress.value = withSpring(0, { damping: 16, stiffness: 260 })
  }

  return (
    <AnimatedPressable
      hitSlop={10}
      onPress={onPress}
      onLongPress={onLongPress}
      delayLongPress={LONG_PRESS_MS}
      onPressIn={() => {
        progress.value = onLongPress
          ? withTiming(1, { duration: LONG_PRESS_MS, easing: Easing.out(Easing.quad) })
          : withTiming(0.4, { duration: 90 })
      }}
      onPressOut={release}
      accessibilityRole="button"
      accessibilityLabel={`Tag ${tag}`}
      accessibilityHint="Opens the notes with this tag. Long press for tag actions."
      style={[styles.chip, { backgroundColor: fill }, animatedStyle]}
    >
      <AppText variant="captionEmphasis" color={textColor}>
        {tag}
      </AppText>
    </AnimatedPressable>
  )
}

const AnimatedPressable = Animated.createAnimatedComponent(Pressable)

interface TagAction {
  key: 'open' | 'remove'
  label: string
  icon: IconName
  destructive?: boolean
  onPress: () => void
}

/**
 * The long-press menu for one chip.
 *
 * It names both verbs rather than relying on the gesture alone, so the sheet
 * also teaches what the plain tap does.
 */
function TagActionSheet({
  tag,
  onClose,
  onOpen,
  onRemove
}: {
  tag: string | null
  onClose: () => void
  onOpen: (tag: string) => void
  onRemove: (tag: string) => void
}) {
  const c = useColors()
  const insets = useSafeAreaInsets()
  const pendingAction = useRef<(() => void) | null>(null)
  const runPendingAction = (): void => {
    const action = pendingAction.current
    pendingAction.current = null
    action?.()
  }

  const actions: readonly TagAction[] = tag
    ? [
        {
          key: 'open',
          label: 'Show notes with this tag',
          icon: 'list',
          onPress: () => onOpen(tag)
        },
        {
          key: 'remove',
          label: 'Remove from this note',
          icon: 'trash',
          destructive: true,
          onPress: () => onRemove(tag)
        }
      ]
    : []

  return (
    <BottomSheet
      visible={tag !== null}
      onClose={onClose}
      onDismiss={runPendingAction}
      accessibilityLabel={tag ? `Actions for tag ${tag}` : 'Tag actions'}
      style={{ paddingBottom: insets.bottom }}
    >
      <View style={styles.sheetHeader}>
        <AppText variant="headline" numberOfLines={1}>
          {tag ?? ''}
        </AppText>
        <AppText variant="caption" color={c.text.secondary}>
          Tag actions
        </AppText>
      </View>
      <View style={[styles.sheetActions, { borderTopColor: c.line.border }]}>
        {actions.map((action, index) => {
          const color = action.destructive ? c.ui.destructiveText : c.text.primary
          return (
            <Pressable
              key={action.key}
              accessibilityRole="button"
              accessibilityLabel={action.label}
              onPress={() => {
                // Same sequencing as `NoteMoreSheet`: the action runs once this
                // Modal is really gone, or navigation races its dismissal.
                pendingAction.current = action.onPress
                onClose()
                if (Platform.OS !== 'ios') {
                  void InteractionManager.runAfterInteractions(runPendingAction)
                }
              }}
              style={({ pressed }) => [
                styles.sheetAction,
                index > 0 && {
                  borderTopColor: c.line.border,
                  borderTopWidth: StyleSheet.hairlineWidth
                },
                pressed && { backgroundColor: c.canvas.surface }
              ]}
            >
              <View style={styles.sheetIconSlot}>
                <Icon name={action.icon} size={22} color={color} />
              </View>
              <AppText color={color} style={styles.sheetActionLabel}>
                {action.label}
              </AppText>
            </Pressable>
          )
        })}
      </View>
    </BottomSheet>
  )
}

const styles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    alignItems: 'center',
    minHeight: 32,
    gap: space.s8
  },
  chip: { paddingVertical: space.s4, paddingHorizontal: 10, borderRadius: radius.full },
  sheetHeader: {
    height: 53,
    justifyContent: 'center',
    gap: space.s2,
    paddingStart: space.s16,
    paddingEnd: space.s16
  },
  sheetActions: { borderTopWidth: StyleSheet.hairlineWidth },
  sheetAction: {
    height: 52,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 14,
    paddingStart: space.s16,
    paddingEnd: space.s16
  },
  sheetIconSlot: {
    width: 24,
    height: 24,
    flexShrink: 0,
    alignItems: 'center',
    justifyContent: 'center'
  },
  sheetActionLabel: { flex: 1, minWidth: 0 }
})
