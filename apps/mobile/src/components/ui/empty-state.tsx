import { StyleSheet, View, type StyleProp, type ViewStyle } from 'react-native'

import { AppText } from '@/components/ui/app-text'
import { Icon, type IconName } from '@/components/ui/icon'
import { radius, space } from '@/theme/primitives'
import { useColors } from '@/theme/use-colors'

export interface EmptyStateProps {
  title: string
  body: string
  icon?: IconName
  style?: StyleProp<ViewStyle>
}

export function EmptyState({ title, body, icon = 'note', style }: EmptyStateProps) {
  const c = useColors()

  return (
    <View style={[styles.container, style]}>
      <View style={[styles.iconContainer, { backgroundColor: c.canvas.surface }]}>
        <Icon name={icon} size={24} color={c.text.tertiary} />
      </View>
      <AppText variant="headline" color={c.text.primary}>
        {title}
      </AppText>
      <AppText variant="subhead" color={c.text.secondary} style={styles.body}>
        {body}
      </AppText>
    </View>
  )
}

const styles = StyleSheet.create({
  container: {
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: space.s40,
    gap: space.s12
  },
  // 56 square, because Figma's 24 x 56 pill is a hug-width authoring slip
  iconContainer: {
    width: 56,
    height: 56,
    borderRadius: radius.full,
    alignItems: 'center',
    justifyContent: 'center'
  },
  body: { textAlign: 'center' }
})
