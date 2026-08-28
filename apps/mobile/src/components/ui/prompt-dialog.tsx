import { useState } from 'react'
import { KeyboardAvoidingView, Modal, Platform, Pressable, StyleSheet, View } from 'react-native'

import { AppText } from '@/components/ui/app-text'
import { TextField } from '@/components/ui/text-field'
import { fontFamilies } from '@/theme/fonts'
import { sizes, space } from '@/theme/primitives'
import { useColors } from '@/theme/use-colors'

/**
 * A one-field alert (boards 26E `New folder`, 26J `Rename`).
 *
 * Not `Alert.prompt`, which is iOS-only: the move sheet already ships an
 * affordance that is simply absent on Android for that reason, and `New
 * folder` is not something this app can offer on one platform only. Drawn
 * rather than delegated, so both platforms get the same dialog.
 */

export interface PromptDialogProps {
  visible: boolean
  title: string
  message?: string
  /** Prefilled and selected on open, the way iOS's own rename field behaves. */
  initialValue?: string
  placeholder?: string
  confirmLabel: string
  onConfirm: (value: string) => void
  onCancel: () => void
}

export function PromptDialog(props: PromptDialogProps) {
  const { visible, title, onCancel } = props
  return (
    <Modal transparent visible={visible} animationType="fade" onRequestClose={onCancel}>
      {/* Keyed by the title so reopening the dialog for a different row mounts
          a fresh body and the draft starts from that row's value by
          construction, never from the previous row's. */}
      {visible ? <PromptBody key={title} {...props} /> : null}
    </Modal>
  )
}

function PromptBody({
  title,
  message,
  initialValue = '',
  placeholder,
  confirmLabel,
  onConfirm,
  onCancel
}: PromptDialogProps) {
  const c = useColors()
  const [value, setValue] = useState(initialValue)
  const trimmed = value.trim()

  return (
    <View style={styles.root}>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="Cancel"
        onPress={onCancel}
        style={[StyleSheet.absoluteFill, styles.scrim, { backgroundColor: c.text.primary }]}
      />
      <KeyboardAvoidingView
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
        style={styles.center}
        pointerEvents="box-none"
      >
        <View
          accessibilityViewIsModal
          accessibilityLabel={title}
          style={[styles.card, { backgroundColor: c.canvas.background }]}
        >
          <View style={styles.body}>
            <AppText variant="callout" style={[styles.title, { color: c.text.primary }]}>
              {title}
            </AppText>
            {message ? (
              <AppText variant="footnote" color={c.text.secondary} style={styles.message}>
                {message}
              </AppText>
            ) : null}
            <TextField
              value={value}
              onChangeText={setValue}
              placeholder={placeholder}
              autoFocus
              selectTextOnFocus
              autoCapitalize="none"
              autoCorrect={false}
              returnKeyType="done"
              onSubmitEditing={() => {
                if (trimmed.length > 0) onConfirm(trimmed)
              }}
              style={styles.field}
            />
          </View>

          <View style={[styles.buttons, { borderTopColor: c.line.border }]}>
            <Pressable accessibilityRole="button" onPress={onCancel} style={styles.button}>
              <AppText color={c.text.primary}>Cancel</AppText>
            </Pressable>
            <View style={[styles.buttonDivider, { backgroundColor: c.line.border }]} />
            <Pressable
              accessibilityRole="button"
              accessibilityState={{ disabled: trimmed.length === 0 }}
              disabled={trimmed.length === 0}
              // `onPressIn`, not `onPress`: confirming unmounts this dialog,
              // and a press whose target disappears between down and up never
              // produces a press event.
              onPressIn={() => onConfirm(trimmed)}
              style={styles.button}
            >
              <AppText
                color={trimmed.length === 0 ? c.text.tertiary : c.text.primary}
                style={styles.confirm}
              >
                {confirmLabel}
              </AppText>
            </Pressable>
          </View>
        </View>
      </KeyboardAvoidingView>
    </View>
  )
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  scrim: { opacity: 0.4 },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  card: {
    width: 270,
    borderRadius: 14,
    overflow: 'hidden',
    boxShadow: [{ offsetX: 0, offsetY: 16, blurRadius: 40, color: 'rgba(31, 29, 26, 0.28)' }]
  },
  body: { paddingHorizontal: sizes.gutter, paddingTop: space.s20, paddingBottom: space.s16 },
  title: { textAlign: 'center', fontFamily: fontFamilies.sansSemiBold, letterSpacing: -0.16 },
  message: { textAlign: 'center', marginTop: space.s6 },
  field: { marginTop: space.s12 },
  buttons: { height: 44, flexDirection: 'row', borderTopWidth: StyleSheet.hairlineWidth },
  button: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  buttonDivider: { width: StyleSheet.hairlineWidth },
  confirm: { fontFamily: fontFamilies.sansSemiBold }
})
