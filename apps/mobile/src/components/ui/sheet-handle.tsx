import { StyleSheet, View, type StyleProp, type ViewStyle } from 'react-native'

import { radius } from '@/theme/primitives'
import { useColors } from '@/theme/use-colors'

export interface SheetHandleProps {
  style?: StyleProp<ViewStyle>
}

export function SheetHandle({ style }: SheetHandleProps) {
  const c = useColors()

  return (
    <View style={[styles.container, style]}>
      <View style={[styles.bar, { backgroundColor: c.line.border }]} />
    </View>
  )
}

const styles = StyleSheet.create({
  container: {
    height: 20,
    alignItems: 'center',
    justifyContent: 'center'
  },
  bar: { width: 36, height: 5, borderRadius: radius.full }
})
