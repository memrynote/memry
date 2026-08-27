import { Text, type TextProps } from 'react-native'

import type { Color } from '@/theme/colors'
import { textStyles, type TextVariant } from '@/theme/text-styles'
import { useColors } from '@/theme/use-colors'

export interface AppTextProps extends TextProps {
  variant?: TextVariant
  color?: Color
}

export function AppText({ variant = 'body', color, style, ...rest }: AppTextProps) {
  const c = useColors()
  return <Text style={[textStyles[variant], { color: color ?? c.text.primary }, style]} {...rest} />
}
