import { useCallback, useState } from 'react'
import { Pressable, StyleSheet, Switch, TextInput, View } from 'react-native'
import { ThemedText } from '@/components/themed-text'
import { Spacing } from '@/constants/theme'
import {
  coercePropertyValue,
  formatPropertyValue,
  inferPropertyType,
  removeNoteProperty,
  setNoteProperty,
  type MobilePropertyType,
  type NoteOpsContext
} from './note-ops'

/**
 * Note properties (T069 / FR-016).
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
}

export function NoteProperties({
  ctx,
  noteId,
  properties,
  readOnly,
  onChanged
}: NotePropertiesProps) {
  const [newKey, setNewKey] = useState('')

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

  const entries = Object.entries(properties)

  return (
    <View style={styles.container}>
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
          onRemove={() => void drop(name)}
        />
      ))}
      {readOnly ? null : (
        <TextInput
          value={newKey}
          onChangeText={setNewKey}
          onSubmitEditing={() => {
            const name = newKey.trim()
            setNewKey('')
            // New properties start as text; the inference only ever runs over a
            // value that already exists, so a fresh key has nothing to infer from.
            if (name.length > 0 && !(name in properties)) void commit(name, '')
          }}
          placeholder="Add a property"
          autoCapitalize="none"
          returnKeyType="done"
          style={styles.input}
          accessibilityLabel="Add a property"
        />
      )}
    </View>
  )
}

function PropertyRow({
  name,
  value,
  type,
  readOnly,
  onCommit,
  onRemove
}: {
  name: string
  value: unknown
  type: MobilePropertyType
  readOnly: boolean
  onCommit: (value: unknown) => void
  onRemove: () => void
}) {
  const initial = formatPropertyValue(value)
  const [draft, setDraft] = useState(initial)

  // Only an actual edit is committed. Blur alone must not write, or merely
  // focusing a field re-pushes whatever it happened to be showing.
  const commitIfChanged = (): void => {
    if (draft === initial) return
    onCommit(coercePropertyValue(type, draft))
  }

  return (
    <View style={styles.row}>
      <ThemedText type="small" style={styles.name}>
        {name}
      </ThemedText>
      {type === 'checkbox' ? (
        <Switch
          value={value === true}
          disabled={readOnly}
          onValueChange={(next) => onCommit(next)}
          accessibilityLabel={name}
        />
      ) : (
        <TextInput
          value={draft}
          editable={!readOnly}
          onChangeText={setDraft}
          onBlur={commitIfChanged}
          onSubmitEditing={commitIfChanged}
          keyboardType={type === 'number' ? 'decimal-pad' : 'default'}
          autoCapitalize={type === 'url' ? 'none' : 'sentences'}
          style={styles.value}
          accessibilityLabel={name}
        />
      )}
      {readOnly ? null : (
        <Pressable
          onPress={onRemove}
          accessibilityRole="button"
          accessibilityLabel={`Remove ${name}`}
        >
          <ThemedText type="small">✕</ThemedText>
        </Pressable>
      )}
    </View>
  )
}

const styles = StyleSheet.create({
  container: { gap: Spacing.one },
  row: { flexDirection: 'row', alignItems: 'center', gap: Spacing.two, minHeight: 44 },
  name: { flexBasis: 110, flexGrow: 0 },
  value: { flex: 1, fontSize: 15, minHeight: 44 },
  input: {
    minHeight: 44,
    fontSize: 15,
    paddingHorizontal: Spacing.two,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: 'rgba(120,113,108,0.4)',
    borderRadius: 8
  }
})
