# Mobile UI foundation, design contract

Synthesized from three independent design packages. This is the contract the implementation fills in.
Measured values live in `figma-foundation-spec.md`. This file owns the shape.

## Decisions

### Colours are the only themed axis

`space`, `radius`, `sizes`, `textStyles` and `fontAssets` are theme independent and are plain imports.
Only colours go through a hook. Routing theme independent constants through a hook would be a layer
that only forwards.

Caveat, named on purpose. If Warm or Dark ever needs a different type ramp or spacing, this claim
breaks and `useColors` has to widen into `useTheme`. Desktop's Warm and Dark share token names and
differ only in hexes, so the narrow claim holds today.

### Nested by Figma group, not flat keys

`canvas/surface-active` in the Figma file and the spec doc reads as `c.canvas.surfaceActive` in code.
One to one, no mental translation while cross checking against `figma-foundation-spec.md`.

### `useColors()` today returns a constant, no context, no provider

A plain `import { colors }` would fail the "adding Dark edits no component file" requirement, because
every module scope `StyleSheet.create` holding a colour bakes it in at import time and would have to
move into a component body later. That is the whole component library.

A context today is a provider with no job for a value that never changes, plus a wrapper in every
render test.

The hook name is the seam. Components write `const c = useColors()` now. When a second theme ships,
`use-colors.ts` gains the context read and `app/_layout.tsx` gains the provider. Two files, zero
component edits.

### Colour values are branded

`Color` is `string & { readonly [colorBrand]: 'themeColor' }`. A prop typed `Color` rejects `'#0891b2'`,
so "a component file never contains a hex" is a compile error rather than a review comment. The single
`as` cast lives in `brandTheme`, which is the trust boundary.

### Weight is unrepresentable

There is no weight axis anywhere in the type model. React Native selects a loaded Google font by its
per weight PostScript family string. Setting `fontWeight` next to one makes Android synthesize or fall
back. `fontFamilies` holds seven role named strings, `FontFamily` is the union of those values, and
`TextVariantStyle` has no `fontWeight` field.

### The legacy theme layer is left alone

`src/constants/theme.ts`, `src/hooks/use-theme.ts`, `themed-text.tsx` and `themed-view.tsx` are not
touched, not deleted, not re-pointed at the new tokens.

22 files consume them, including every screen in the shipping sign-in, vaults, unlock and notes flow.
Those screens have no design in this Figma pass and get redesigned in the next step. Re-pointing them
now would change their colours (`#000000` to `#37352f`) with no spec to check the result against, and
migrating them would be churn on files about to be rewritten.

Cost accepted, two text vocabularies coexist until the screen work lands. Follow up issue tracks the sweep.

## Module map

No barrel. Imports name the owning file, so a grep and an import agree on where a token lives.

| File                             | Owns                                                                             |
| -------------------------------- | -------------------------------------------------------------------------------- |
| `src/theme/colors/white.ts`      | the 30 White hexes, plus `ui.destructiveText`. The only file with hex literals   |
| `src/theme/colors/index.ts`      | `Color` brand, `ThemeSource`, `ThemeColors`, `brandTheme`, `themes`, `ThemeName` |
| `src/theme/use-colors.ts`        | the single reactive seam. Body today is `return themes.white`                    |
| `src/theme/primitives.ts`        | `space`, `radius`, `sizes`                                                       |
| `src/theme/fonts.ts`             | `fontFamilies` role map, `fontAssets` load map, `FontFamily`                     |
| `src/theme/text-styles.ts`       | the 17 variants, `TextVariant`                                                   |
| `src/components/ui/app-text.tsx` | `AppText`, the one place a variant becomes style objects                         |
| `src/components/ui/icon.tsx`     | `Icon`, the one place a Lucide glyph gets a token colour and a stroke            |
| `src/components/ui/*.tsx`        | one file per component                                                           |

## Type contract

```ts
declare const colorBrand: unique symbol
export type Color = string & { readonly [colorBrand]: 'themeColor' }

export type ThemeSource = typeof white
type Branded<T> = { readonly [K in keyof T]: T[K] extends string ? Color : Branded<T[K]> }
export type ThemeColors = Branded<ThemeSource>

export function brandTheme(source: ThemeSource): ThemeColors
export const themes: { white: ThemeColors }
export type ThemeName = keyof typeof themes

export function useColors(): ThemeColors
```

```ts
interface TextVariantStyle {
  fontFamily: FontFamily
  fontSize: number
  lineHeight: number
  letterSpacing: number
}
export type TextVariant = keyof typeof textStyles
```

`letterSpacing` is required, not optional. Every measured value is known, so an omission would be a
silent gap rather than a visible zero.

```tsx
export interface AppTextProps extends TextProps {
  variant?: TextVariant
  color?: Color
}
```

Variant styles never carry colour, so a colour override loses nothing. Style array order is
`[textStyles[variant], { color }, props.style]`, caller wins last.

## Press feedback

Pointer down, scale 0.97. `Pressable` with `onPressIn` driving the scale, not `onPress`. Buttons and
rows only. No springs this pass. Reanimated stays out of the foundation layer.

## RTL

Logical props only. `paddingStart`, `marginEnd`, `start`, `end`, `textAlign: 'start'`. Never `left`,
`right`, `paddingLeft`, `marginRight`, `textAlign: 'left'`.

## Tab bar background is swappable

The tab bar takes its background as a prop defaulting to the solid `canvas/background`. Translucency
lands later by passing a blur surface. `expo-blur` is not a dependency this pass.
