import {
  StyleSheet,
  TextInput,
  View,
  type StyleProp,
  type TextInputProps,
  type ViewStyle
} from 'react-native'

import { Icon } from '@/components/ui/icon'
import { radius, space } from '@/theme/primitives'
import { textStyles } from '@/theme/text-styles'
import { useColors } from '@/theme/use-colors'

export interface SearchFieldProps extends Omit<TextInputProps, 'style'> {
  style?: StyleProp<ViewStyle>
}

export function SearchField({ style, ...rest }: SearchFieldProps) {
  const c = useColors()

  return (
    <View
      accessibilityRole="search"
      style={[styles.container, { backgroundColor: c.canvas.surface }, style]}
    >
      <Icon name="search" size={18} color={c.text.tertiary} />
      <TextInput
        placeholderTextColor={c.text.secondary}
        style={[styles.input, textStyles.callout, { color: c.text.primary }]}
        {...rest}
      />
    </View>
  )
}

const styles = StyleSheet.create({
  container: {
    height: 36,
    borderRadius: radius.md,
    paddingHorizontal: space.s8,
    gap: space.s6,
    flexDirection: 'row',
    alignItems: 'center'
  },
  input: { flex: 1, padding: 0 }
})
