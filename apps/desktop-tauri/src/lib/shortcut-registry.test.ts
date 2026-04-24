import { describe, it, expect } from 'vitest'
import type { ShortcutBinding } from '@memry/contracts/settings-schemas'
import {
  SHORTCUT_REGISTRY,
  CATEGORY_ORDER,
  formatBinding,
  resolveBinding,
  bindingsEqual,
  findConflicts,
  getGroupedShortcuts,
  type ShortcutEntry
} from './shortcut-registry'

describe('shortcut-registry', () => {
  describe('SHORTCUT_REGISTRY data integrity', () => {
    it('every entry has required fields', () => {
      for (const entry of SHORTCUT_REGISTRY) {
        expect(entry.id).toBeTruthy()
        expect(entry.label).toBeTruthy()
        expect(entry.description).toBeTruthy()
        expect(entry.category).toBeTruthy()
        expect(entry.defaultBinding).toBeDefined()
        expect(entry.defaultBinding.key).toBeTruthy()
        expect(entry.defaultBinding.modifiers).toBeDefined()
      }
    })

    it('no duplicate IDs', () => {
      const ids = SHORTCUT_REGISTRY.map((e) => e.id)
      expect(new Set(ids).size).toBe(ids.length)
    })

    it('all IDs follow dot-notation', () => {
      for (const entry of SHORTCUT_REGISTRY) {
        expect(entry.id).toMatch(/^[a-z]+\.[a-zA-Z]+$/)
      }
    })

    it('all categories are in CATEGORY_ORDER', () => {
      const cats = new Set(SHORTCUT_REGISTRY.map((e) => e.category))
      for (const cat of cats) {
        expect(CATEGORY_ORDER).toContain(cat)
      }
    })

    it('has entries in every declared category', () => {
      for (const cat of CATEGORY_ORDER) {
        const entries = SHORTCUT_REGISTRY.filter((e) => e.category === cat)
        expect(entries.length).toBeGreaterThan(0)
      }
    })
  })

  describe('formatBinding', () => {
    it('formats single modifier + key', () => {
      const binding: ShortcutBinding = { key: 'n', modifiers: { meta: true } }
      const result = formatBinding(binding)
      expect(result).toMatch(/N$/)
      expect(result).toMatch(/⌘|Ctrl/)
    })

    it('formats multiple modifiers', () => {
      const binding: ShortcutBinding = { key: 't', modifiers: { meta: true, shift: true } }
      const result = formatBinding(binding)
      expect(result).toContain('Shift')
      expect(result).toMatch(/T$/)
    })

    it('formats special keys', () => {
      const binding: ShortcutBinding = { key: 'Tab', modifiers: { ctrl: true } }
      const result = formatBinding(binding)
      expect(result).toContain('Ctrl')
      expect(result).toContain('⇥')
    })

    it('uppercases regular keys', () => {
      const binding: ShortcutBinding = { key: 'f', modifiers: { meta: true } }
      const result = formatBinding(binding)
      expect(result).toMatch(/F$/)
    })

    it('maps arrow keys to symbols', () => {
      const binding: ShortcutBinding = { key: 'ArrowUp', modifiers: {} }
      expect(formatBinding(binding)).toContain('↑')
    })

    it('maps Enter to ↩', () => {
      const binding: ShortcutBinding = { key: 'Enter', modifiers: {} }
      expect(formatBinding(binding)).toContain('↩')
    })

    it('maps Backspace to ⌫', () => {
      const binding: ShortcutBinding = { key: 'Backspace', modifiers: {} }
      expect(formatBinding(binding)).toContain('⌫')
    })
  })

  describe('resolveBinding', () => {
    const entry: ShortcutEntry = {
      id: 'test.shortcut',
      label: 'Test',
      description: 'Test shortcut',
      category: 'Navigation',
      defaultBinding: { key: 'n', modifiers: { meta: true } }
    }

    it('returns default when no override', () => {
      expect(resolveBinding(entry, {})).toEqual(entry.defaultBinding)
    })

    it('returns override when present', () => {
      const override: ShortcutBinding = { key: 'x', modifiers: { meta: true, shift: true } }
      expect(resolveBinding(entry, { 'test.shortcut': override })).toEqual(override)
    })

    it('ignores overrides for different IDs', () => {
      const override: ShortcutBinding = { key: 'x', modifiers: { meta: true } }
      expect(resolveBinding(entry, { 'other.shortcut': override })).toEqual(entry.defaultBinding)
    })
  })

  describe('bindingsEqual', () => {
    it('returns true for identical bindings', () => {
      const a: ShortcutBinding = { key: 'n', modifiers: { meta: true } }
      const b: ShortcutBinding = { key: 'n', modifiers: { meta: true } }
      expect(bindingsEqual(a, b)).toBe(true)
    })

    it('is case-insensitive on key', () => {
      const a: ShortcutBinding = { key: 'N', modifiers: { meta: true } }
      const b: ShortcutBinding = { key: 'n', modifiers: { meta: true } }
      expect(bindingsEqual(a, b)).toBe(true)
    })

    it('returns false for different keys', () => {
      const a: ShortcutBinding = { key: 'n', modifiers: { meta: true } }
      const b: ShortcutBinding = { key: 'x', modifiers: { meta: true } }
      expect(bindingsEqual(a, b)).toBe(false)
    })

    it('returns false for different modifiers', () => {
      const a: ShortcutBinding = { key: 'n', modifiers: { meta: true } }
      const b: ShortcutBinding = { key: 'n', modifiers: { meta: true, shift: true } }
      expect(bindingsEqual(a, b)).toBe(false)
    })

    it('treats undefined and false modifiers as equal', () => {
      const a: ShortcutBinding = { key: 'n', modifiers: { meta: true } }
      const b: ShortcutBinding = { key: 'n', modifiers: { meta: true, shift: false, alt: false } }
      expect(bindingsEqual(a, b)).toBe(true)
    })
  })

  describe('findConflicts', () => {
    it('returns empty when no conflicts', () => {
      const unique: ShortcutBinding = {
        key: 'z',
        modifiers: { meta: true, shift: true, alt: true }
      }
      expect(findConflicts('nav.newNote', unique, {})).toHaveLength(0)
    })

    it('detects conflict with existing default binding', () => {
      const conflicting: ShortcutBinding = { key: 'f', modifiers: { meta: true } }
      const conflicts = findConflicts('custom.id', conflicting, {})
      expect(conflicts.length).toBeGreaterThan(0)
      expect(conflicts[0].conflictingId).toBe('nav.search')
      expect(conflicts[0].conflictingLabel).toBe('Search')
    })

    it('excludes self from conflict check', () => {
      const searchBinding = SHORTCUT_REGISTRY.find((e) => e.id === 'nav.search')!.defaultBinding
      const conflicts = findConflicts('nav.search', searchBinding, {})
      expect(conflicts.every((c) => c.conflictingId !== 'nav.search')).toBe(true)
    })

    it('considers overrides when checking conflicts', () => {
      const overrides: Record<string, ShortcutBinding> = {
        'nav.search': { key: 'z', modifiers: { meta: true, alt: true } }
      }
      const conflicts = findConflicts(
        'custom.id',
        { key: 'z', modifiers: { meta: true, alt: true } },
        overrides
      )
      expect(conflicts.some((c) => c.conflictingId === 'nav.search')).toBe(true)
    })

    it('does not conflict when override removes the collision', () => {
      const overrides: Record<string, ShortcutBinding> = {
        'nav.search': { key: 'z', modifiers: { meta: true, alt: true } }
      }
      const conflicts = findConflicts(
        'custom.id',
        { key: 'f', modifiers: { meta: true } },
        overrides
      )
      expect(conflicts.every((c) => c.conflictingId !== 'nav.search')).toBe(true)
    })
  })

  describe('getGroupedShortcuts', () => {
    it('returns a Map with all categories', () => {
      const grouped = getGroupedShortcuts()
      for (const cat of CATEGORY_ORDER) {
        expect(grouped.has(cat)).toBe(true)
      }
    })

    it('preserves CATEGORY_ORDER ordering', () => {
      const grouped = getGroupedShortcuts()
      const keys = [...grouped.keys()]
      for (let i = 0; i < CATEGORY_ORDER.length; i++) {
        expect(keys[i]).toBe(CATEGORY_ORDER[i])
      }
    })

    it('every entry is placed in its category', () => {
      const grouped = getGroupedShortcuts()
      let total = 0
      for (const entries of grouped.values()) {
        total += entries.length
      }
      expect(total).toBe(SHORTCUT_REGISTRY.length)
    })

    it('entries within a category match their category field', () => {
      const grouped = getGroupedShortcuts()
      for (const [cat, entries] of grouped) {
        for (const entry of entries) {
          expect(entry.category).toBe(cat)
        }
      }
    })
  })
})
