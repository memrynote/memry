import { describe, it, expect } from 'vitest'
import fs from 'fs'
import path from 'path'
import { THEME_VARIABLES, labelForThemeVariable } from './theme-variables'

describe('THEME_VARIABLES registry', () => {
  it('every registry variable exists in base.css (drift guard)', () => {
    const baseCss = fs.readFileSync(path.resolve(__dirname, '../assets/base.css'), 'utf-8')
    const missing = THEME_VARIABLES.filter((def) => !baseCss.includes(def.cssVar)).map(
      (def) => def.cssVar
    )
    expect(missing).toEqual([])
  })

  it('has no duplicate variables', () => {
    const names = THEME_VARIABLES.map((def) => def.cssVar)
    expect(new Set(names).size).toBe(names.length)
  })

  it('every variable is a CSS custom property in a known group', () => {
    for (const def of THEME_VARIABLES) {
      expect(def.cssVar.startsWith('--')).toBe(true)
      expect(['core', 'advanced']).toContain(def.group)
      expect(def.section.length).toBeGreaterThan(0)
    }
  })

  it('includes the core surfaces, sidebar set, and accent', () => {
    const names = new Set(THEME_VARIABLES.map((def) => def.cssVar))
    for (const expected of [
      '--background',
      '--surface',
      '--surface-active',
      '--border',
      '--sidebar',
      '--user-accent-color'
    ]) {
      expect(names.has(expected)).toBe(true)
    }
  })
})

describe('labelForThemeVariable', () => {
  it('derives a readable label from the variable name', () => {
    expect(labelForThemeVariable({ cssVar: '--surface-active', group: 'core', section: 'x' })).toBe(
      'Surface Active'
    )
  })

  it('prefers an explicit label when provided', () => {
    expect(
      labelForThemeVariable({
        cssVar: '--user-accent-color',
        group: 'core',
        section: 'x',
        label: 'Accent'
      })
    ).toBe('Accent')
  })
})
