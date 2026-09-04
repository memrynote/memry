import { useCallback, useState } from 'react'
import { Alert, Pressable, StyleSheet, Switch, TextInput, View } from 'react-native'

import { AppText } from '@/components/ui/app-text'
import { BottomSheet } from '@/components/ui/bottom-sheet'
import { Icon } from '@/components/ui/icon'
import { fontFamilies } from '@/theme/fonts'
import { radius, sizes, space } from '@/theme/primitives'
import { useColors } from '@/theme/use-colors'
import {
  STATUS_OPTIONS,
  coercePropertyValue,
  formatPropertyValue,
  inferPropertyType,
  removeNoteProperty,
  setNoteProperty,
  type MobilePropertyType,
  type NoteOpsContext
} from './note-ops'
import { propertyTypes, statusPastel } from './property-types'

/**
 * Note properties, inline under the title (board 32).
 *
 * Types are INFERRED from the stored value using desktop's fallback rules (the
 * definition files that carry the real type are not readable on mobile yet),
 * and an edit never changes the inferred type: writing `"3"` over a number
 * would retype the value for every other device.
 */
export interface NotePropertiesProps {
  ctx: NoteOpsContext | null
  noteId: string
  properties: Record<string, unknown>
  readOnly: boolean
  onChanged: (properties: Record<string, unknown>) => void
  onAddProperty: () => void
  onAddTag: () => void
  /** Any tap in this section also leaves the tag row's editing state. */
  onInteract: () => void
}

export function NoteProperties({
  ctx,
  noteId,
  properties,
  readOnly,
  onChanged,
  onAddProperty,
  onAddTag,
  onInteract
}: NotePropertiesProps) {
  const c = useColors()
  const [expanded, setExpanded] = useState(false)
  const [statusTarget, setStatusTarget] = useState<string | null>(null)

  const commit = useCallback(
    async (name: string, value: unknown) => {
      onChanged({ ...properties, [name]: value })
      if (ctx) await setNoteProperty(ctx, noteId, name, value)
    },
    [ctx, noteId, onChanged, properties]
  )

  const drop = useCallback(
    async (name: string) => {
      const next = { ...properties }
      delete next[name]
      onChanged(next)
      if (ctx) await removeNoteProperty(ctx, noteId, name)
    },
    [ctx, noteId, onChanged, properties]
  )

  const confirmDrop = useCallback(
    (name: string) => {
      if (readOnly) return
      Alert.alert(`Remove “${name}”?`, 'This removes the property on every device.', [
        { text: 'Cancel', style: 'cancel' },
        { text: 'Remove', style: 'destructive', onPress: () => void drop(name) }
      ])
    },
    [drop, readOnly]
  )

  const entries = Object.entries(properties)

  return (
    <View>
      <Pressable
        hitSlop={10}
        onPress={() => {
          onInteract()
          setExpanded((prev) => !prev)
        }}
        accessibilityRole="button"
        accessibilityLabel="Properties"
        accessibilityState={{ expanded }}
        style={styles.header}
      >
        {/* Collapsed and expanded differ by the chevron alone: the board's
            tertiary label colour fails contrast (D2), so both states land on
            `text.secondary` and shipping two identical colours as if they
            differed would be a lie. */}
        <View style={expanded ? styles.chevronExpanded : undefined}>
          <Icon
            name="chevron-right"
            size={12}
            strokeWidth={2.5}
            color={expanded ? c.tint.text : c.text.secondary}
          />
        </View>
        <AppText color={c.text.secondary} style={styles.sectionText}>
          Properties
        </AppText>
        <AppText color={c.text.secondary} style={styles.countText}>
          {`· ${entries.length}`}
        </AppText>
      </Pressable>

      {expanded ? (
        <View style={styles.list}>
          {entries.map(([name, value]) => (
            <PropertyRow
              // Keyed by the VALUE as well as the name: a pull that changes this
              // property remounts the row, so its draft starts from the new value.
              // A draft that survived would be written back on the next blur,
              // silently overwriting the newer remote value with a stale one.
              key={`${name}:${formatPropertyValue(value)}`}
              name={name}
              value={value}
              type={inferPropertyType(name, value)}
              readOnly={readOnly}
              onCommit={(next) => void commit(name, next)}
              onPickStatus={() => setStatusTarget(name)}
              onLongPress={() => confirmDrop(name)}
              onInteract={onInteract}
            />
          ))}

          {readOnly ? null : (
            <View style={styles.ghostRow}>
              <GhostButton label="Add property" onPress={onAddProperty} />
              <GhostButton label="Add tag" onPress={onAddTag} />
            </View>
          )}
        </View>
      ) : null}

      <BottomSheet
        visible={statusTarget !== null}
        onClose={() => setStatusTarget(null)}
        accessibilityLabel="Status"
      >
        <View style={styles.statusList}>
          {STATUS_OPTIONS.map((option) => (
            <Pressable
              key={option.value}
              onPress={() => {
                if (statusTarget) void commit(statusTarget, option.value)
                setStatusTarget(null)
              }}
              accessibilityRole="button"
              accessibilityLabel={option.value}
              style={styles.statusOption}
            >
              <View style={[styles.pill, { backgroundColor: statusPastel(c, option.color) }]}>
                <AppText variant="captionEmphasis">{option.value}</AppText>
              </View>
            </Pressable>
          ))}
        </View>
      </BottomSheet>
    </View>
  )
}

function GhostButton({ label, onPress }: { label: string; onPress: () => void }) {
  const c = useColors()
  return (
    <Pressable
      hitSlop={10}
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={label}
      style={[styles.ghost, { borderColor: c.line.border }]}
    >
      <Icon name="plus" size={12} color={c.text.secondary} />
      <AppText color={c.text.secondary} style={styles.ghostLabel}>
        {label}
      </AppText>
    </Pressable>
  )
}

function PropertyRow({
  name,
  value,
  type,
  readOnly,
  onCommit,
  onPickStatus,
  onLongPress,
  onInteract
}: {
  name: string
  value: unknown
  type: MobilePropertyType
  readOnly: boolean
  onCommit: (value: unknown) => void
  onPickStatus: () => void
  onLongPress: () => void
  onInteract: () => void
}) {
  const c = useColors()
  const initial = formatPropertyValue(value)
  const [draft, setDraft] = useState(initial)

  // Only an actual edit is committed. Blur alone must not write, or merely
  // focusing a field re-pushes whatever it happened to be showing.
  const commitIfChanged = (): void => {
    if (draft === initial) return
    onCommit(coercePropertyValue(type, draft))
  }

  return (
    <Pressable onPress={onInteract} onLongPress={onLongPress} style={styles.row}>
      <View style={styles.iconLane}>
        <Icon name={propertyTypes[type].icon} size={14} color={c.text.secondary} />
      </View>
      <AppText color={c.text.secondary} style={[styles.nameLane, styles.rowText]}>
        {name}
      </AppText>
      <View style={styles.valueLane}>
        {type === 'status' ? (
          <Pressable
            hitSlop={10}
            disabled={readOnly}
            onPress={onPickStatus}
            accessibilityRole="button"
            accessibilityLabel={name}
            style={[styles.pill, { backgroundColor: statusPastel(c, statusColorOf(initial)) }]}
          >
            {/* The STORED value, verbatim. Contracts spells it `In Progress`. */}
            <AppText variant="captionEmphasis">{initial}</AppText>
          </Pressable>
        ) : type === 'checkbox' ? (
          <Switch
            value={value === true}
            disabled={readOnly}
            onValueChange={(next) => onCommit(next)}
            accessibilityLabel={name}
          />
        ) : type === 'date' ? (
          <AppText
            color={initial.length > 0 ? c.text.primary : c.text.secondary}
            style={styles.rowText}
          >
            {initial.length > 0 ? initial : 'Empty'}
          </AppText>
        ) : (
          <TextInput
            value={draft}
            editable={!readOnly}
            onChangeText={setDraft}
            onFocus={onInteract}
            onBlur={commitIfChanged}
            onSubmitEditing={commitIfChanged}
            keyboardType={type === 'number' ? 'decimal-pad' : 'default'}
            autoCapitalize={type === 'url' ? 'none' : 'sentences'}
            accessibilityLabel={name}
            style={[styles.rowText, { color: c.text.primary }]}
          />
        )}
      </View>
    </Pressable>
  )
}

function statusColorOf(value: string): string {
  return STATUS_OPTIONS.find((option) => option.value === value)?.color ?? 'stone'
}

const styles = StyleSheet.create({
  header: {
    alignSelf: 'flex-start',
    flexDirection: 'row',
    alignItems: 'center',
    paddingEnd: space.s8,
    paddingVertical: space.s4,
    gap: space.s6
  },
  // 11/16 with 0.09em tracking resolved to px, which no ramp variant carries.
  sectionText: { fontFamily: fontFamilies.sans, fontSize: 11, lineHeight: 16, letterSpacing: 0.99 },
  countText: { fontFamily: fontFamilies.sansMedium, fontSize: 11, lineHeight: 16 },
  list: { paddingTop: 10 },
  row: { flexDirection: 'row', alignItems: 'center', paddingVertical: space.s6 },
  iconLane: { width: 20, flexShrink: 0 },
  nameLane: { width: 112, flexShrink: 0 },
  valueLane: { flex: 1 },
  rowText: { fontFamily: fontFamilies.sans, fontSize: 13, lineHeight: 16 },
  pill: {
    alignSelf: 'flex-start',
    paddingVertical: space.s2,
    paddingHorizontal: space.s8,
    borderRadius: radius.full
  },
  chevronExpanded: { transform: [{ rotate: '90deg' }] },
  ghostRow: { flexDirection: 'row', gap: space.s12 },
  ghost: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.s6,
    paddingVertical: space.s4,
    paddingHorizontal: space.s8,
    borderRadius: radius.md,
    borderWidth: 1,
    borderStyle: 'dashed'
  },
  ghostLabel: { fontFamily: fontFamilies.sans, fontSize: 12, lineHeight: 12 },
  statusList: { paddingHorizontal: sizes.gutter, paddingBottom: space.s20 },
  statusOption: { height: sizes.tapTarget, justifyContent: 'center' }
})
