import { useCallback, useState } from 'react'
import { Pressable, StyleSheet, TextInput, View } from 'react-native'
import { AppText } from '@/components/ui/app-text'
import { radius, sizes, space } from '@/theme/primitives'
import { textStyles } from '@/theme/text-styles'
import { useColors } from '@/theme/use-colors'
import { addTag, removeTag, setNoteTags, type NoteOpsContext } from './note-ops'

/**
 * Note tags (T068 / FR-015).
 *
 * Case-PRESERVING, case-insensitive: what the user typed is what is stored,
 * and `Roadmap` cannot be added twice as `roadmap`. Matching desktop here is
 * not cosmetic — a mobile edit that lower-cased tags would rewrite them for
 * every device on the next sync.
 */
export interface NoteTagsProps {
  ctx: NoteOpsContext | null
  noteId: string
  tags: string[]
  readOnly: boolean
  onChanged: (tags: string[]) => void
}

export function NoteTags({ ctx, noteId, tags, readOnly, onChanged }: NoteTagsProps) {
  const c = useColors()
  const [draft, setDraft] = useState('')

  const commit = useCallback(
    async (next: string[]) => {
      onChanged(next)
      if (ctx) await setNoteTags(ctx, noteId, next)
    },
    [ctx, noteId, onChanged]
  )

  const submit = useCallback(async () => {
    const next = addTag(tags, draft)
    setDraft('')
    if (next !== tags) await commit(next)
  }, [commit, draft, tags])

  return (
    <View style={styles.container}>
      <View style={styles.row}>
        {tags.map((tag) => (
          <Pressable
            key={tag}
            disabled={readOnly}
            onPress={() => void commit(removeTag(tags, tag))}
            style={[styles.chip, { backgroundColor: c.canvas.surface }]}
            accessibilityRole="button"
            accessibilityLabel={`Remove tag ${tag}`}
          >
            <AppText variant="caption" color={c.text.secondary}>
              #{tag}
            </AppText>
          </Pressable>
        ))}
      </View>
      {readOnly ? null : (
        <TextInput
          value={draft}
          onChangeText={setDraft}
          onSubmitEditing={submit}
          onBlur={submit}
          placeholder="Add a tag"
          autoCapitalize="none"
          autoCorrect={false}
          returnKeyType="done"
          placeholderTextColor={c.text.tertiary}
          style={[
            styles.input,
            textStyles.subhead,
            { borderColor: c.line.input, color: c.text.primary }
          ]}
          accessibilityLabel="Add a tag"
        />
      )}
    </View>
  )
}

const styles = StyleSheet.create({
  container: { gap: space.s4 },
  row: { flexDirection: 'row', flexWrap: 'wrap', gap: space.s4 },
  chip: {
    minHeight: 32,
    justifyContent: 'center',
    paddingHorizontal: space.s8,
    borderRadius: radius.full
  },
  input: {
    minHeight: sizes.tapTarget,
    paddingHorizontal: space.s8,
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: radius.md
  }
})
