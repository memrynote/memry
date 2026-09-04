import { useCallback, useEffect, useMemo, useState } from 'react'
import { Alert, Pressable, StyleSheet, TextInput, View } from 'react-native'

import type { SelectOption } from '@memry/contracts/property-types'
import { AppText } from '@/components/ui/app-text'
import { BottomSheet } from '@/components/ui/bottom-sheet'
import { Icon } from '@/components/ui/icon'
import { optionColor } from '@/theme/colors/tag-colors'
import { fontFamilies } from '@/theme/fonts'
import { radius, sizes, space } from '@/theme/primitives'
import { useColors } from '@/theme/use-colors'
import {
  coercePropertyValue,
  formatPropertyValue,
  inferPropertyType,
  removeNoteProperty,
  setNoteProperty,
  type MobilePropertyType,
  type NoteOpsContext
} from './note-ops'
import { readPropertyDefinitions, type MobilePropertyDefinition } from './property-definitions'
import { SELECT_TYPES, propertyTypes } from './property-types'

/**
 * Note properties, inline under the title (board 32).
 *
 * The vault's `property_definition` rows replicate now, so a property's type
 * and its option colours are read rather than guessed. That is what makes this
 * row render the way the desktop does: `area` is a select with an indigo `Work`
 * chip, not a text field showing the word Work. A property no definition covers
 * still falls back to the value-shape rules, which is the desktop's own
 * behaviour in that case.
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

/** The open option picker: which property, and the options it can pick from. */
interface PickerTarget {
  name: string
  type: MobilePropertyType
  options: SelectOption[]
  selected: string[]
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
  const [picker, setPicker] = useState<PickerTarget | null>(null)
  const [definitions, setDefinitions] = useState<Map<string, MobilePropertyDefinition>>(
    () => new Map()
  )

  const db = ctx?.db ?? null
  useEffect(() => {
    if (!db) return
    let live = true
    void readPropertyDefinitions(db).then((next) => {
      if (live) setDefinitions(next)
    })
    return () => {
      live = false
    }
  }, [db])

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

  const rows = useMemo(
    () =>
      Object.entries(properties).map(([name, value]) => {
        const definition = definitions.get(name)
        return {
          name,
          value,
          definition,
          type: inferPropertyType(name, value, definition?.type)
        }
      }),
    [definitions, properties]
  )

  const pickOption = useCallback(
    (option: SelectOption) => {
      if (!picker) return
      if (picker.type === 'multiselect') {
        const next = picker.selected.includes(option.value)
          ? picker.selected.filter((entry) => entry !== option.value)
          : [...picker.selected, option.value]
        void commit(picker.name, next)
        setPicker({ ...picker, selected: next })
        return
      }
      void commit(picker.name, option.value)
      setPicker(null)
    },
    [commit, picker]
  )

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
          {`· ${rows.length}`}
        </AppText>
      </Pressable>

      {expanded ? (
        <View style={styles.list}>
          {rows.map((row) => (
            <PropertyRow
              // Keyed by the VALUE as well as the name: a pull that changes this
              // property remounts the row, so its draft starts from the new value.
              // A draft that survived would be written back on the next blur,
              // silently overwriting the newer remote value with a stale one.
              key={`${row.name}:${formatPropertyValue(row.value)}`}
              name={row.name}
              value={row.value}
              type={row.type}
              definition={row.definition}
              readOnly={readOnly}
              onCommit={(next) => void commit(row.name, next)}
              onOpenPicker={(options, selected) =>
                setPicker({ name: row.name, type: row.type, options, selected })
              }
              onLongPress={() => confirmDrop(row.name)}
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
        visible={picker !== null}
        onClose={() => setPicker(null)}
        accessibilityLabel={picker?.name ?? 'Options'}
      >
        <View style={styles.optionList}>
          {picker?.options.length === 0 ? (
            // A select whose definition has not reached this device yet, or one
            // the desktop never gave options. Saying so beats an empty sheet.
            <AppText color={c.text.secondary} style={styles.rowText}>
              No options defined for this property.
            </AppText>
          ) : null}
          {picker?.options.map((option) => {
            const hue = optionColor(option.color)
            const selected = picker.selected.includes(option.value)
            return (
              <Pressable
                key={option.value}
                onPress={() => pickOption(option)}
                accessibilityRole="button"
                accessibilityLabel={option.value}
                accessibilityState={{ selected }}
                style={styles.optionRow}
              >
                <View style={[styles.pill, { backgroundColor: hue.fill }]}>
                  <AppText variant="captionEmphasis" color={hue.text}>
                    {option.value}
                  </AppText>
                </View>
                {selected ? <Icon name="check" size={16} color={c.tint.text} /> : null}
              </Pressable>
            )
          })}
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

/** A value as a list of chip labels. One chip for a select, many for the rest. */
function chipValues(type: MobilePropertyType, value: unknown): string[] {
  if (Array.isArray(value)) return value.filter((entry) => typeof entry === 'string')
  if (value === null || value === undefined || value === '') return []
  return [type === 'multiselect' ? String(value) : String(value)]
}

function PropertyRow({
  name,
  value,
  type,
  definition,
  readOnly,
  onCommit,
  onOpenPicker,
  onLongPress,
  onInteract
}: {
  name: string
  value: unknown
  type: MobilePropertyType
  definition: MobilePropertyDefinition | undefined
  readOnly: boolean
  onCommit: (value: unknown) => void
  onOpenPicker: (options: SelectOption[], selected: string[]) => void
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
        <PropertyValue
          name={name}
          value={value}
          type={type}
          definition={definition}
          initial={initial}
          draft={draft}
          readOnly={readOnly}
          onDraftChange={setDraft}
          onCommit={onCommit}
          onCommitDraft={commitIfChanged}
          onOpenPicker={onOpenPicker}
          onInteract={onInteract}
        />
      </View>
    </Pressable>
  )
}

function PropertyValue({
  name,
  value,
  type,
  definition,
  initial,
  draft,
  readOnly,
  onDraftChange,
  onCommit,
  onCommitDraft,
  onOpenPicker,
  onInteract
}: {
  name: string
  value: unknown
  type: MobilePropertyType
  definition: MobilePropertyDefinition | undefined
  initial: string
  draft: string
  readOnly: boolean
  onDraftChange: (next: string) => void
  onCommit: (value: unknown) => void
  onCommitDraft: () => void
  onOpenPicker: (options: SelectOption[], selected: string[]) => void
  onInteract: () => void
}) {
  const c = useColors()

  if (SELECT_TYPES.includes(type)) {
    const selected = chipValues(type, value)
    const options = definition?.options ?? []
    return (
      <Pressable
        hitSlop={10}
        disabled={readOnly}
        onPress={() => onOpenPicker(options, selected)}
        accessibilityRole="button"
        accessibilityLabel={name}
        style={styles.chipRow}
      >
        {selected.length === 0 ? <EmptyValue /> : null}
        {selected.map((entry) => {
          // A value the definition does not list is real data — a note written
          // before the option was renamed, or in another app. The desktop
          // paints it `stone` rather than dropping it, so this does too.
          const hue = optionColor(
            options.find((option) => option.value === entry)?.color ?? 'stone'
          )
          return (
            <View key={entry} style={[styles.pill, { backgroundColor: hue.fill }]}>
              {/* The STORED value, verbatim. Contracts spells it `In Progress`. */}
              <AppText variant="captionEmphasis" color={hue.text}>
                {entry}
              </AppText>
            </View>
          )
        })}
      </Pressable>
    )
  }

  if (type === 'project' || type === 'relation') {
    const entries = chipValues(type, value)
    return (
      <View style={styles.chipRow}>
        {entries.length === 0 ? <EmptyValue /> : null}
        {entries.map((entry) => (
          <View key={entry} style={[styles.pill, { backgroundColor: c.canvas.surface }]}>
            <AppText variant="captionEmphasis" color={c.text.primary}>
              {entry}
            </AppText>
          </View>
        ))}
      </View>
    )
  }

  if (type === 'checkbox') {
    const checked = value === true
    return (
      <Pressable
        hitSlop={10}
        disabled={readOnly}
        onPress={() => onCommit(!checked)}
        accessibilityRole="checkbox"
        accessibilityLabel={name}
        accessibilityState={{ checked }}
        // The desktop draws a small tinted square, not a platform switch. A
        // switch reads as a setting; the value here is a checked box.
        style={[
          styles.checkbox,
          checked
            ? { backgroundColor: c.tint.base, borderColor: c.tint.base }
            : { borderColor: c.line.border }
        ]}
      >
        {checked ? (
          <Icon name="check" size={12} strokeWidth={3} color={c.canvas.background} />
        ) : null}
      </Pressable>
    )
  }

  if (type === 'date') {
    return initial.length > 0 ? (
      <AppText color={c.text.primary} style={styles.rowText}>
        {initial}
      </AppText>
    ) : (
      <EmptyValue />
    )
  }

  return (
    <TextInput
      value={draft}
      editable={!readOnly}
      onChangeText={onDraftChange}
      onFocus={onInteract}
      onBlur={onCommitDraft}
      onSubmitEditing={onCommitDraft}
      keyboardType={type === 'number' ? 'decimal-pad' : 'default'}
      autoCapitalize={type === 'url' ? 'none' : 'sentences'}
      placeholder="Empty"
      placeholderTextColor={c.text.secondary}
      accessibilityLabel={name}
      style={[styles.rowText, { color: type === 'url' ? c.tint.text : c.text.primary }]}
    />
  )
}

function EmptyValue() {
  const c = useColors()
  return (
    <AppText color={c.text.secondary} style={styles.rowText}>
      Empty
    </AppText>
  )
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
  chipRow: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: space.s6 },
  pill: {
    alignSelf: 'flex-start',
    paddingVertical: space.s2,
    paddingHorizontal: space.s8,
    borderRadius: radius.full
  },
  checkbox: {
    width: 18,
    height: 18,
    borderRadius: radius.sm,
    borderWidth: 1.5,
    alignItems: 'center',
    justifyContent: 'center'
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
  optionList: { paddingHorizontal: sizes.gutter, paddingBottom: space.s20 },
  optionRow: {
    height: sizes.tapTarget,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between'
  }
})
