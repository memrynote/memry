import { useState } from 'react'
import { Pressable, StyleSheet, TextInput, View } from 'react-native'

import { AppText } from '@/components/ui/app-text'
import { BottomSheet } from '@/components/ui/bottom-sheet'
import { Icon } from '@/components/ui/icon'
import { fontFamilies } from '@/theme/fonts'
import { radius, sizes, space } from '@/theme/primitives'
import { textStyles } from '@/theme/text-styles'
import { useColors } from '@/theme/use-colors'
import type { MobilePropertyType } from './note-ops'
import { addablePropertyTypes, propertyTypes } from './property-types'

export interface AddPropertySheetProps {
  visible: boolean
  /** Names already on this note; picking a type is a no-op against one of these. */
  existingNames: string[]
  onClose: () => void
  onCreate: (name: string, type: MobilePropertyType) => void
}

/**
 * Board 32's add sheet.
 *
 * `BottomSheet` already draws the grabber and rounds its top corners at
 * `radius.xl`; the board says 20, and one board does not outrank the primitive
 * every other sheet in the app uses.
 */
export function AddPropertySheet(props: AddPropertySheetProps) {
  return (
    <BottomSheet visible={props.visible} onClose={props.onClose} accessibilityLabel="Add property">
      {/* Mounted only while open, so the name field starts empty by
          construction rather than by an effect that resets it. */}
      {props.visible ? <AddPropertyBody {...props} /> : null}
    </BottomSheet>
  )
}

function AddPropertyBody({ existingNames, onClose, onCreate }: AddPropertySheetProps) {
  const c = useColors()
  const [type, setType] = useState<MobilePropertyType | null>(null)
  const [name, setName] = useState('')

  const trimmed = name.trim()
  const usable = trimmed.length > 0 && !existingNames.includes(trimmed)

  if (type === null) {
    return (
      <>
        <View style={styles.header}>
          <AppText variant="headline">Add property</AppText>
          <Pressable hitSlop={10} onPress={onClose} accessibilityRole="button">
            <AppText variant="headline" color={c.tint.text}>
              Cancel
            </AppText>
          </Pressable>
        </View>

        <View style={styles.sectionLabel}>
          <AppText color={c.text.secondary} style={styles.sectionText}>
            TYPE
          </AppText>
        </View>

        <View style={styles.list}>
          {addablePropertyTypes.map((entryType) => {
            const entry = propertyTypes[entryType]
            return (
              <Pressable
                key={entryType}
                onPress={() => setType(entryType)}
                accessibilityRole="button"
                accessibilityLabel={entry.label}
                style={styles.item}
              >
                <View style={styles.iconLane}>
                  <Icon name={entry.icon} size={16} color={c.text.secondary} />
                </View>
                <AppText variant="subhead">{entry.label}</AppText>
                <View style={styles.spacer} />
                <Icon name="chevron-right" size={16} color={c.text.tertiary} />
              </Pressable>
            )
          })}
        </View>
      </>
    )
  }

  const entry = propertyTypes[type]
  const submit = () => {
    if (usable) onCreate(trimmed, type)
  }

  return (
    <>
      <View style={styles.header}>
        {/* Back returns to the type list; the typed name survives so a
            mistaken type choice does not cost the name. */}
        <Pressable
          hitSlop={10}
          onPress={() => setType(null)}
          accessibilityRole="button"
          accessibilityLabel="Back to property types"
          style={styles.back}
        >
          <Icon name="chevron-left" size={18} color={c.tint.text} />
          <AppText variant="headline" color={c.tint.text}>
            {entry.label}
          </AppText>
        </Pressable>
        <Pressable
          hitSlop={10}
          onPress={submit}
          disabled={!usable}
          accessibilityRole="button"
          accessibilityLabel="Add property"
          accessibilityState={{ disabled: !usable }}
        >
          <AppText variant="headline" color={usable ? c.tint.text : c.text.tertiary}>
            Add
          </AppText>
        </Pressable>
      </View>

      <View style={styles.fieldRow}>
        <TextInput
          autoFocus
          value={name}
          onChangeText={setName}
          onSubmitEditing={submit}
          placeholder="Property name"
          placeholderTextColor={c.text.tertiary}
          autoCapitalize="none"
          autoCorrect={false}
          returnKeyType="done"
          accessibilityLabel="Property name"
          style={[
            styles.field,
            textStyles.subhead,
            {
              backgroundColor: c.canvas.surface,
              borderColor: c.line.border,
              color: c.text.primary
            }
          ]}
        />
      </View>
    </>
  )
}

const styles = StyleSheet.create({
  header: {
    height: sizes.navBar,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: sizes.gutter
  },
  fieldRow: { paddingHorizontal: sizes.gutter, paddingBottom: space.s20 },
  field: {
    height: 40,
    paddingHorizontal: space.s12,
    borderRadius: radius.md,
    borderWidth: 1
  },
  sectionLabel: { height: 28, justifyContent: 'center', paddingHorizontal: sizes.gutter },
  sectionText: {
    fontFamily: fontFamilies.sansMedium,
    fontSize: 11,
    lineHeight: 16,
    letterSpacing: 0.99
  },
  list: { paddingHorizontal: sizes.gutter, paddingBottom: space.s20 },
  item: { height: sizes.tapTarget, flexDirection: 'row', alignItems: 'center', gap: space.s12 },
  iconLane: { width: 24, flexShrink: 0 },
  spacer: { flex: 1 },
  back: { flexDirection: 'row', alignItems: 'center', gap: space.s4 }
})
