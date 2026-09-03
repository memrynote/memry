import { useCallback } from 'react'
import { Pressable, StyleSheet, View } from 'react-native'

import { AppText } from '@/components/ui/app-text'
import { Icon } from '@/components/ui/icon'
import { tagColor } from '@/theme/colors/tag-colors'
import { radius, space } from '@/theme/primitives'
import { useColors } from '@/theme/use-colors'
import { removeTag, setNoteTags, type NoteOpsContext } from './note-ops'

/**
 * The inline tag row (board 33).
 *
 * Case-PRESERVING, case-insensitive: what the user typed is what is stored,
 * and `Roadmap` cannot be added twice as `roadmap`. Matching desktop here is
 * not cosmetic — a mobile edit that lower-cased tags would rewrite them for
 * every device on the next sync.
 *
 * The row has two states. At rest it is plain chips. Tapping any chip arms the
 * editing state, which adds a remove badge to every chip and a dashed add
 * button after them; the screen disarms it when a tap lands anywhere else.
 */
export interface NoteTagsProps {
  ctx: NoteOpsContext | null
  noteId: string
  tags: string[]
  readOnly: boolean
  editing: boolean
  onEditingChange: (editing: boolean) => void
  onAdd: () => void
  onChanged: (tags: string[]) => void
}

export function NoteTags({
  ctx,
  noteId,
  tags,
  readOnly,
  editing,
  onEditingChange,
  onAdd,
  onChanged
}: NoteTagsProps) {
  const c = useColors()

  const commit = useCallback(
    async (next: string[]) => {
      onChanged(next)
      if (ctx) await setNoteTags(ctx, noteId, next)
    },
    [ctx, noteId, onChanged]
  )

  const armed = editing && !readOnly

  return (
    <View style={styles.row}>
      {tags.map((tag) => {
        const hue = tagColor(tag)
        return (
          <Pressable
            key={tag}
            hitSlop={10}
            disabled={readOnly}
            onPress={() => onEditingChange(true)}
            accessibilityRole="button"
            accessibilityLabel={`Tag ${tag}`}
            style={[styles.chip, { backgroundColor: hue.fill }]}
          >
            <AppText variant="captionEmphasis" color={hue.text}>
              {tag}
            </AppText>
            {armed ? (
              <Pressable
                hitSlop={10}
                onPress={() => void commit(removeTag(tags, tag))}
                accessibilityRole="button"
                accessibilityLabel={`Remove tag ${tag}`}
                style={[styles.badge, { backgroundColor: c.text.secondary }]}
              >
                <Icon name="close" size={8} strokeWidth={3} color={c.canvas.background} />
              </Pressable>
            ) : null}
          </Pressable>
        )
      })}
      {!readOnly && (armed || tags.length === 0) ? (
        <Pressable
          hitSlop={10}
          onPress={onAdd}
          accessibilityRole="button"
          accessibilityLabel="Add tag"
          style={[styles.add, { borderColor: c.line.border }]}
        >
          {/* `text.tertiary` is 2.81:1 on the canvas and fails the 3:1 glyph
              floor DESIGN.md sets, so every tertiary mark on boards 32 and 33
              is drawn in `text.secondary` instead. */}
          <Icon name="plus" size={12} color={c.text.secondary} />
        </Pressable>
      ) : null}
    </View>
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
  badge: {
    position: 'absolute',
    top: -space.s4,
    end: -space.s4,
    width: 14,
    height: 14,
    borderRadius: radius.full,
    alignItems: 'center',
    justifyContent: 'center'
  },
  add: {
    width: 24,
    height: 24,
    borderRadius: radius.full,
    borderWidth: 1.5,
    borderStyle: 'dashed',
    alignItems: 'center',
    justifyContent: 'center'
  }
})
