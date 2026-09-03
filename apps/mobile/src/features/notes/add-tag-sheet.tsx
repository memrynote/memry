import { useEffect, useMemo, useState } from 'react'
import {
  Pressable,
  ScrollView,
  StyleSheet,
  TextInput,
  useWindowDimensions,
  View
} from 'react-native'

import { AppText } from '@/components/ui/app-text'
import { BottomSheet } from '@/components/ui/bottom-sheet'
import { Icon } from '@/components/ui/icon'
import type { VaultDb } from '@/db/index'
import { tagColor } from '@/theme/colors/tag-colors'
import { fontFamilies } from '@/theme/fonts'
import { radius, sizes, space } from '@/theme/primitives'
import { textStyles } from '@/theme/text-styles'
import { useColors } from '@/theme/use-colors'
import { normalizeTagKey, readVaultTags } from './note-ops'

export interface AddTagSheetProps {
  visible: boolean
  db: VaultDb | null
  /** Tags already on this note; they are never offered again. */
  existing: string[]
  onClose: () => void
  onPick: (tag: string) => void
}

/**
 * Board 33's add sheet.
 *
 * The vault's tag list is scanned when the sheet OPENS, not on every render of
 * the note screen — it is a full pass over the note payloads.
 */
export function AddTagSheet(props: AddTagSheetProps) {
  const { height } = useWindowDimensions()

  return (
    <BottomSheet
      visible={props.visible}
      onClose={props.onClose}
      accessibilityLabel="Add tag"
      // A real vault carries hundreds of tags. Without a ceiling the wrapped
      // chip list grows past the screen, taking the header and its Cancel with
      // it, and the sheet has no way back. The cap plus the shrinking scroller
      // below keeps the header, the field and the footer pinned however many
      // tags match.
      style={{ maxHeight: height * 0.7 }}
    >
      {/* Mounted only while open, so the query starts empty by construction and
          the vault scan runs once per opening rather than once per render. */}
      {props.visible ? <AddTagBody {...props} /> : null}
    </BottomSheet>
  )
}

function AddTagBody({ db, existing, onClose, onPick }: AddTagSheetProps) {
  const c = useColors()
  const [query, setQuery] = useState('')
  const [vaultTags, setVaultTags] = useState<string[]>([])

  useEffect(() => {
    if (db) void readVaultTags(db).then(setVaultTags)
  }, [db])

  const { matching, canCreate } = useMemo(() => {
    const key = normalizeTagKey(query)
    const taken = new Set(existing.map(normalizeTagKey))
    const available = vaultTags.filter((tag) => !taken.has(normalizeTagKey(tag)))
    return {
      matching: available.filter((tag) => normalizeTagKey(tag).includes(key)),
      canCreate:
        key.length > 0 && !vaultTags.some((tag) => normalizeTagKey(tag) === key) && !taken.has(key)
    }
  }, [existing, query, vaultTags])

  return (
    <>
      <View style={styles.header}>
        <AppText variant="headline">Add tag</AppText>
        <Pressable hitSlop={10} onPress={onClose} accessibilityRole="button">
          <AppText variant="headline" color={c.tint.text}>
            Cancel
          </AppText>
        </Pressable>
      </View>

      <View style={styles.fieldRow}>
        <View
          style={[styles.field, { backgroundColor: c.canvas.surface, borderColor: c.line.border }]}
        >
          <Icon name="search" size={16} color={c.text.secondary} />
          <TextInput
            // Deliberately NOT autofocused. The keyboard covers the lower half
            // of the sheet, which is the tag list itself, and browsing is the
            // common action in a vault with hundreds of tags. Typing is one tap
            // away. The add-property sheet keeps its autofocus because its name
            // field is the only way forward there.
            value={query}
            onChangeText={setQuery}
            placeholder="Search or create"
            placeholderTextColor={c.text.tertiary}
            autoCapitalize="none"
            autoCorrect={false}
            returnKeyType="done"
            onSubmitEditing={() => {
              if (canCreate) onPick(query.trim())
            }}
            accessibilityLabel="Search tags"
            style={[styles.input, textStyles.subhead, { color: c.text.primary }]}
          />
        </View>
      </View>

      <View style={styles.sectionLabel}>
        <AppText variant="caption" color={c.text.secondary} style={styles.sectionText}>
          {/* Board 33 only ever draws this with a query typed. With an empty
              one the list is the whole vault, and calling that MATCHING would
              be false. */}
          {query.trim().length > 0 ? 'MATCHING' : 'ALL TAGS'}
        </AppText>
      </View>

      <ScrollView
        style={styles.chipsScroll}
        contentContainerStyle={styles.chips}
        // Without this the first tap on a chip is spent dismissing the keyboard
        // the autofocused field raised, and the tag is never added.
        keyboardShouldPersistTaps="handled"
      >
        {matching.map((tag) => {
          const hue = tagColor(tag)
          return (
            <Pressable
              key={tag}
              hitSlop={10}
              onPress={() => onPick(tag)}
              accessibilityRole="button"
              accessibilityLabel={`Add tag ${tag}`}
              style={[styles.chip, { backgroundColor: hue.fill }]}
            >
              <AppText variant="captionEmphasis" color={hue.text}>
                {tag}
              </AppText>
            </Pressable>
          )
        })}
        {canCreate ? (
          <Pressable
            hitSlop={10}
            onPress={() => onPick(query.trim())}
            accessibilityRole="button"
            accessibilityLabel={`Create tag ${query.trim()}`}
            style={[styles.createChip, { borderColor: c.line.border }]}
          >
            <Icon name="plus" size={10} strokeWidth={3} color={c.text.secondary} />
            <AppText variant="captionEmphasis" color={c.text.secondary}>
              {`Create "${query.trim()}"`}
            </AppText>
          </Pressable>
        ) : null}
      </ScrollView>

      <View style={styles.footer}>
        <AppText variant="caption" color={c.text.secondary}>
          Tags keep the case you type but match without it — Commons and commons are the same tag.
        </AppText>
      </View>
    </>
  )
}

const styles = StyleSheet.create({
  // The scroller is the only part that gives, so everything around it is
  // pinned. Without these the header and the footer shrink instead.
  header: {
    height: sizes.navBar,
    flexShrink: 0,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: sizes.gutter
  },
  fieldRow: { flexShrink: 0, paddingHorizontal: sizes.gutter, paddingBottom: space.s12 },
  field: {
    height: 40,
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.s8,
    paddingHorizontal: space.s12,
    borderRadius: radius.md,
    borderWidth: 1
  },
  input: { flex: 1 },
  sectionLabel: {
    height: 28,
    flexShrink: 0,
    justifyContent: 'center',
    paddingHorizontal: sizes.gutter
  },
  // 11/16 with 0.09em tracking resolved to px, which `caption` does not carry.
  sectionText: {
    fontFamily: fontFamilies.sansMedium,
    fontSize: 11,
    lineHeight: 16,
    letterSpacing: 0.99
  },
  chipsScroll: { flexShrink: 1 },
  chips: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: space.s6,
    paddingHorizontal: sizes.gutter,
    paddingBottom: space.s12
  },
  chip: { paddingVertical: space.s4, paddingHorizontal: 10, borderRadius: radius.full },
  createChip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.s4,
    paddingVertical: space.s4,
    paddingHorizontal: 10,
    borderRadius: radius.full,
    borderWidth: 1.5,
    borderStyle: 'dashed'
  },
  footer: { flexShrink: 0, paddingHorizontal: sizes.gutter, paddingBottom: space.s20 }
})
