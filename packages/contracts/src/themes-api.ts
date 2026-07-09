/**
 * Custom Theme Schemas
 *
 * Custom themes fork a built-in base theme and store only overridden CSS
 * color variables. Write-side inputs validate strictly (6-digit hex, custom
 * property keys); read-side parsing stays lenient and relies on
 * sanitizeThemeVariables so files written by newer app versions never fail
 * to load on older ones.
 *
 * @module contracts/themes-api
 */

import { z } from 'zod'

export const THEME_BASES = ['light', 'white', 'dark'] as const

export const ThemeBaseSchema = z.enum(THEME_BASES)

export type ThemeBase = z.infer<typeof ThemeBaseSchema>

export const THEME_HEX_REGEX = /^#[0-9a-fA-F]{6}$/

export const ThemeVariablesInputSchema = z.record(
  z.string().startsWith('--'),
  z.string().regex(THEME_HEX_REGEX)
)

export const CustomThemeSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1).max(64),
  base: ThemeBaseSchema,
  variables: z.record(z.string(), z.string()),
  createdAt: z.string(),
  modifiedAt: z.string()
})

export type CustomTheme = z.infer<typeof CustomThemeSchema>

export const CreateThemeInputSchema = z.object({
  name: z.string().min(1).max(64),
  base: ThemeBaseSchema,
  variables: ThemeVariablesInputSchema.optional()
})

export type CreateThemeInput = z.infer<typeof CreateThemeInputSchema>

export const UpdateThemeInputSchema = z.object({
  name: z.string().min(1).max(64).optional(),
  base: ThemeBaseSchema.optional(),
  variables: ThemeVariablesInputSchema.optional()
})

export type UpdateThemeInput = z.infer<typeof UpdateThemeInputSchema>

/**
 * Read-side tolerance: keep only `--var: #rrggbb` entries, drop everything
 * else (unknown shapes, future value syntaxes, non-custom-property keys).
 */
export function sanitizeThemeVariables(input: unknown): Record<string, string> {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) return {}
  const result: Record<string, string> = {}
  for (const [key, value] of Object.entries(input)) {
    if (!key.startsWith('--')) continue
    if (typeof value !== 'string' || !THEME_HEX_REGEX.test(value)) continue
    result[key] = value
  }
  return result
}
