import { white } from '@/theme/colors/white'

declare const colorBrand: unique symbol

export type Color = string & { readonly [colorBrand]: 'themeColor' }

export type ThemeSource = typeof white

type Branded<T> = { readonly [K in keyof T]: T[K] extends string ? Color : Branded<T[K]> }

export type ThemeColors = Branded<ThemeSource>

export function brandTheme(source: ThemeSource): ThemeColors {
  return source as ThemeColors
}

export const themes = { white: brandTheme(white) }

export type ThemeName = keyof typeof themes
