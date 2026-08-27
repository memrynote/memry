import { themes, type ThemeColors } from '@/theme/colors'

// The reactive seam. Components read colours through a hook so that adding a
// second theme changes this file and the root layout, not every module-scope
// StyleSheet that baked a colour in at import time.
export function useColors(): ThemeColors {
  return themes.white
}
