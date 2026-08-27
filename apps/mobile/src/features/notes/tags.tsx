import { useCallback, useState } from 'react'
import { Pressable, StyleSheet, TextInput, View } from 'react-native'
import { ThemedText } from '@/components/themed-text'
import { Spacing } from '@/constants/theme'
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
            style={styles.chip}
            accessibilityRole="button"
            accessibilityLabel={`Remove tag ${tag}`}
          >
            <ThemedText type="small">#{tag}</ThemedText>
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
          style={styles.input}
          accessibilityLabel="Add a tag"
        />
      )}
    </View>
  )
}

const styles = StyleSheet.create({
  container: { gap: Spacing.one },
  row: { flexDirection: 'row', flexWrap: 'wrap', gap: Spacing.one },
  chip: {
    minHeight: 32,
    justifyContent: 'center',
    paddingHorizontal: Spacing.two,
    borderRadius: 16,
    backgroundColor: 'rgba(255,103,26,0.12)'
  },
  input: {
    minHeight: 44,
    fontSize: 15,
    paddingHorizontal: Spacing.two,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: 'rgba(120,113,108,0.4)',
    borderRadius: 8
  }
})
