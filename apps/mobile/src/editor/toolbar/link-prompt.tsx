import { useState } from 'react'
import { StyleSheet, Text, TextInput, View } from 'react-native'

import type { ToolbarIntents } from '@/editor/toolbar/bottom-chrome'
import { PickerShell } from '@/editor/toolbar/pickers'
import { ToolbarButton } from '@/editor/toolbar/toolbar-button'
import { fontFamilies } from '@/theme/fonts'
import { radius, sizes, space } from '@/theme/primitives'
import { useColors } from '@/theme/use-colors'

/**
 * The one panel that does not replace the keyboard: its own field is what holds
 * the keyboard up, so it sits on top of it at its natural height.
 */
export function LinkPrompt({ intents }: { intents: ToolbarIntents }) {
  const c = useColors()
  const [url, setUrl] = useState('')

  const submit = () => {
    const value = url.trim()
    if (!value) return
    intents.closePanel()
    intents.act({ kind: 'create-link', url: value })
  }

  return (
    <PickerShell title="Add link">
      <View style={styles.form}>
        <TextInput
          accessibilityLabel="Link URL"
          placeholder="https://"
          placeholderTextColor={c.text.tertiary}
          keyboardType="url"
          autoCapitalize="none"
          autoCorrect={false}
          autoFocus
          returnKeyType="done"
          value={url}
          onChangeText={setUrl}
          onSubmitEditing={submit}
          style={[
            styles.input,
            {
              borderColor: c.line.input,
              backgroundColor: c.canvas.background,
              color: c.text.primary
            }
          ]}
        />
        <ToolbarButton
          label="Cancel"
          style={styles.action}
          onPress={() => {
            intents.closePanel()
            intents.act({ kind: 'focus' })
          }}
        >
          {(colour) => <Text style={[styles.actionLabel, { color: colour }]}>Cancel</Text>}
        </ToolbarButton>
        <ToolbarButton
          label="Add link"
          background={c.ui.primary}
          style={styles.action}
          onPress={submit}
        >
          {() => <Text style={[styles.actionLabel, { color: c.canvas.background }]}>Add</Text>}
        </ToolbarButton>
      </View>
    </PickerShell>
  )
}

const styles = StyleSheet.create({
  form: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.s8,
    paddingTop: space.s8,
    paddingHorizontal: space.s12,
    paddingBottom: space.s16
  },
  input: {
    flex: 1,
    minWidth: 0,
    height: sizes.tapTarget,
    paddingVertical: 0,
    paddingHorizontal: space.s12,
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: radius.md,
    fontFamily: fontFamilies.sans,
    fontSize: 16
  },
  action: { width: 'auto', paddingHorizontal: space.s12, borderRadius: radius.md },
  actionLabel: { fontFamily: fontFamilies.sansMedium, fontSize: 14, lineHeight: 18 }
})
