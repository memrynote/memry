import { useCallback, useRef, useState } from 'react'
import { InteractionManager, Platform, Pressable, StyleSheet, TextInput, View } from 'react-native'
import Animated, {
  Easing,
  useAnimatedStyle,
  useSharedValue,
  withSpring,
  withTiming
} from 'react-native-reanimated'
import { useSafeAreaInsets } from 'react-native-safe-area-context'

import { COLOR_ROWS, TAG_COLORS, isHexColor } from '@memry/contracts/tag-colors'

import { AppText } from '@/components/ui/app-text'
import { BottomSheet } from '@/components/ui/bottom-sheet'
import { Icon, type IconName } from '@/components/ui/icon'
import { createLogger } from '@/lib/logger'
import type { Color } from '@/theme/colors'
import { tagColor, type TagColor } from '@/theme/colors/tag-colors'
import { radius, sizes, space } from '@/theme/primitives'
import { textStyles } from '@/theme/text-styles'
import { useColors } from '@/theme/use-colors'
import { normalizeTagKey, removeTag, setNoteTags, type NoteOpsContext } from './note-ops'
import { writeTagColorRow } from './tag-definitions'
import { useTagColors } from './use-tag-colors'

const log = createLogger('NoteTags')

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
  const [overrides, setOverrides] = useState<Map<string, string>>(() => new Map())

  const commit = useCallback(
    async (next: string[]) => {
      onChanged(next)
      if (ctx) await setNoteTags(ctx, noteId, next)
    },
    [ctx, noteId, onChanged]
  )

  const setColor = useCallback(
    (tag: string, color: string) => {
      if (!ctx) return
      // `useTagColors` reads the synced rows once per mount, so the chip would
      // keep its old hue until this screen is remounted without the override.
      setOverrides((prev) => new Map(prev).set(normalizeTagKey(tag), color))
      setMenuTag(null)
      void writeTagColorRow(ctx, tag, color).catch((err: unknown) => {
        log.error('Failed to store the tag colour', { tag, error: String(err) })
      })
    },
    [ctx]
  )

  const hueFor = (tag: string): TagColor => {
    const override = overrides.get(normalizeTagKey(tag))
    return override ? tagColor(tag, override) : resolveColor(tag)
  }

  if (tags.length === 0) return null

  return (
    <View style={styles.row}>
      {tags.map((tag) => {
        const hue = hueFor(tag)
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
        currentColor={menuTag === null ? null : hueFor(menuTag).text}
        onClose={() => setMenuTag(null)}
        onOpen={onOpenTag}
        onRemove={(tag) => void commit(removeTag(tags, tag))}
        onSetColor={setColor}
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
  key: 'open' | 'color' | 'remove'
  label: string
  icon: IconName
  destructive?: boolean
  /** Runs in place instead of through the dismiss-then-act sequencing below. */
  staysOpen?: boolean
  onPress: () => void
}

type SheetMode = 'actions' | 'color'

/**
 * The long-press menu for one chip.
 *
 * It names both verbs rather than relying on the gesture alone, so the sheet
 * also teaches what the plain tap does.
 */
function TagActionSheet({
  tag,
  currentColor,
  onClose,
  onOpen,
  onRemove,
  onSetColor
}: {
  tag: string | null
  currentColor: string | null
  onClose: () => void
  onOpen: (tag: string) => void
  onRemove: (tag: string) => void
  onSetColor: (tag: string, color: string) => void
}) {
  const c = useColors()
  const insets = useSafeAreaInsets()
  const [mode, setMode] = useState<SheetMode>('actions')
  const [hex, setHex] = useState('')
  const [openedFor, setOpenedFor] = useState(tag)
  const pendingAction = useRef<(() => void) | null>(null)
  const runPendingAction = (): void => {
    const action = pendingAction.current
    pendingAction.current = null
    action?.()
  }

  if (tag !== openedFor) {
    setOpenedFor(tag)
    setMode('actions')
    setHex('')
  }

  const applyHex = (): void => {
    if (tag !== null && isHexColor(hex)) onSetColor(tag, hex)
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
          key: 'color',
          label: 'Set colour',
          icon: 'color',
          staysOpen: true,
          onPress: () => setMode('color')
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
      {mode === 'color' && tag !== null ? (
        <View style={[styles.picker, { borderTopColor: c.line.border }]}>
          <View style={styles.pickerHeader}>
            <Pressable
              hitSlop={10}
              accessibilityRole="button"
              accessibilityLabel="Back to tag actions"
              onPress={() => setMode('actions')}
            >
              <Icon name="chevron-left" size={22} color={c.text.primary} />
            </Pressable>
            <AppText variant="headline">Colour</AppText>
          </View>

          {COLOR_ROWS.map((row) => (
            <View key={row.join('-')} style={styles.swatchRow}>
              {row.map((name) => {
                const fill = TAG_COLORS[name].text
                const selected = currentColor?.toLowerCase() === fill.toLowerCase()
                return (
                  <Pressable
                    key={name}
                    accessibilityRole="button"
                    accessibilityLabel={`Set colour ${name}`}
                    onPress={() => onSetColor(tag, name)}
                    style={[styles.swatch, { backgroundColor: fill }]}
                  >
                    {selected ? (
                      <Icon name="check" size={16} strokeWidth={3} color={c.canvas.popover} />
                    ) : null}
                  </Pressable>
                )
              })}
            </View>
          ))}

          <View style={styles.hexRow}>
            <View
              style={[
                styles.field,
                { backgroundColor: c.canvas.surface, borderColor: c.line.border }
              ]}
            >
              <TextInput
                value={hex}
                onChangeText={setHex}
                placeholder="#RRGGBB"
                placeholderTextColor={c.text.tertiary}
                autoCapitalize="none"
                autoCorrect={false}
                maxLength={7}
                returnKeyType="done"
                onSubmitEditing={applyHex}
                accessibilityLabel="Custom colour hex"
                style={[styles.input, textStyles.subhead, { color: c.text.primary }]}
              />
            </View>
            <Pressable
              hitSlop={10}
              disabled={!isHexColor(hex)}
              accessibilityRole="button"
              accessibilityLabel="Apply custom colour"
              onPress={applyHex}
              style={styles.hexApply}
            >
              <AppText variant="headline" color={isHexColor(hex) ? c.tint.text : c.text.tertiary}>
                Apply
              </AppText>
            </Pressable>
          </View>
        </View>
      ) : (
        <View style={[styles.sheetActions, { borderTopColor: c.line.border }]}>
          {actions.map((action, index) => {
            const color = action.destructive ? c.ui.destructiveText : c.text.primary
            return (
              <Pressable
                key={action.key}
                accessibilityRole="button"
                accessibilityLabel={action.label}
                onPress={() => {
                  if (action.staysOpen) {
                    action.onPress()
                    return
                  }
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
      )}
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
  sheetActionLabel: { flex: 1, minWidth: 0 },
  picker: { borderTopWidth: StyleSheet.hairlineWidth, paddingBottom: space.s12 },
  pickerHeader: {
    height: sizes.navBar,
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.s8,
    paddingStart: space.s16,
    paddingEnd: space.s16
  },
  swatchRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    alignItems: 'center',
    gap: space.s12,
    paddingStart: space.s16,
    paddingEnd: space.s16,
    paddingBottom: space.s12
  },
  swatch: {
    width: 32,
    height: 32,
    borderRadius: radius.full,
    alignItems: 'center',
    justifyContent: 'center'
  },
  hexRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.s8,
    paddingStart: space.s16,
    paddingEnd: space.s16
  },
  field: {
    flex: 1,
    height: 40,
    flexDirection: 'row',
    alignItems: 'center',
    paddingStart: space.s12,
    paddingEnd: space.s12,
    borderRadius: radius.md,
    borderWidth: 1
  },
  input: { flex: 1 },
  hexApply: { minHeight: sizes.tapTarget, justifyContent: 'center' }
})
