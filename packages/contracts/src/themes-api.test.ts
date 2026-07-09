/**
 * Custom Theme Contract Tests
 *
 * File/DTO schema for custom themes, strict write-side variable validation,
 * and read-side sanitization tolerance.
 */

import { describe, it, expect } from 'vitest'

import {
  CustomThemeSchema,
  CreateThemeInputSchema,
  UpdateThemeInputSchema,
  ThemeBaseSchema,
  sanitizeThemeVariables
} from './themes-api'

const validTheme = {
  id: 'a1b2c3d4',
  name: 'Tema 1',
  base: 'light',
  variables: { '--background': '#f6f5f0', '--sidebar': '#111111' },
  createdAt: '2026-07-09T10:00:00.000Z',
  modifiedAt: '2026-07-09T10:00:00.000Z'
}

describe('CustomThemeSchema', () => {
  it('accepts a valid theme', () => {
    expect(CustomThemeSchema.safeParse(validTheme).success).toBe(true)
  })

  it('rejects an unknown base', () => {
    expect(CustomThemeSchema.safeParse({ ...validTheme, base: 'system' }).success).toBe(false)
  })

  it('rejects an empty name', () => {
    expect(CustomThemeSchema.safeParse({ ...validTheme, name: '' }).success).toBe(false)
  })

  it('tolerates arbitrary string variable values (read-side leniency)', () => {
    const result = CustomThemeSchema.safeParse({
      ...validTheme,
      variables: { '--background': 'not-a-color' }
    })
    expect(result.success).toBe(true)
  })
})

describe('ThemeBaseSchema', () => {
  it('accepts the three built-in bases only', () => {
    expect(ThemeBaseSchema.safeParse('light').success).toBe(true)
    expect(ThemeBaseSchema.safeParse('white').success).toBe(true)
    expect(ThemeBaseSchema.safeParse('dark').success).toBe(true)
    expect(ThemeBaseSchema.safeParse('warm').success).toBe(false)
  })
})

describe('CreateThemeInputSchema', () => {
  it('accepts name + base', () => {
    expect(CreateThemeInputSchema.safeParse({ name: 'Tema 1', base: 'dark' }).success).toBe(true)
  })

  it('accepts initial variables with valid hex values', () => {
    const result = CreateThemeInputSchema.safeParse({
      name: 'Tema 1',
      base: 'dark',
      variables: { '--background': '#101010' }
    })
    expect(result.success).toBe(true)
  })

  it('rejects non-hex variable values (write-side strictness)', () => {
    const result = CreateThemeInputSchema.safeParse({
      name: 'Tema 1',
      base: 'dark',
      variables: { '--background': 'red' }
    })
    expect(result.success).toBe(false)
  })

  it('rejects variable keys that are not CSS custom properties', () => {
    const result = CreateThemeInputSchema.safeParse({
      name: 'Tema 1',
      base: 'dark',
      variables: { background: '#101010' }
    })
    expect(result.success).toBe(false)
  })
})

describe('UpdateThemeInputSchema', () => {
  it('accepts partial updates', () => {
    expect(UpdateThemeInputSchema.safeParse({ name: 'Renamed' }).success).toBe(true)
    expect(
      UpdateThemeInputSchema.safeParse({ variables: { '--surface': '#ffffff' } }).success
    ).toBe(true)
    expect(UpdateThemeInputSchema.safeParse({}).success).toBe(true)
  })

  it('rejects invalid hex in variables', () => {
    expect(UpdateThemeInputSchema.safeParse({ variables: { '--surface': '#fff' } }).success).toBe(
      false
    )
  })
})

describe('sanitizeThemeVariables', () => {
  it('keeps valid --var: #rrggbb entries', () => {
    expect(sanitizeThemeVariables({ '--background': '#F6F5F0' })).toEqual({
      '--background': '#F6F5F0'
    })
  })

  it('drops invalid hex values and non-custom-property keys', () => {
    expect(
      sanitizeThemeVariables({
        '--background': 'color-mix(in srgb, red, blue)',
        '--surface': '#fff',
        background: '#f6f5f0',
        '--valid': '#123abc'
      })
    ).toEqual({ '--valid': '#123abc' })
  })

  it('returns empty object for undefined/non-object input', () => {
    expect(sanitizeThemeVariables(undefined)).toEqual({})
    expect(sanitizeThemeVariables(null)).toEqual({})
    expect(sanitizeThemeVariables('nope')).toEqual({})
  })
})
