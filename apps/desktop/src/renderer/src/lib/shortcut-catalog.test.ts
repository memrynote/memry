import { describe, it, expect } from 'vitest'
import { readdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { COMMANDS } from '@memry/contracts/commands'
import type { ShortcutBinding } from '@memry/contracts/settings-schemas'
import {
  SHORTCUT_ENTRIES,
  SHORTCUT_GROUP_ORDER,
  formatBinding,
  resolveBinding,
  bindingsEqual,
  findConflicts,
  folderNoteShortcutId,
  getGroupedShortcuts,
  type ShortcutEntry
} from './shortcut-catalog'

describe('shortcut-catalog', () => {
  describe('SHORTCUT_ENTRIES data integrity', () => {
    it('every entry has required fields', () => {
      for (const entry of SHORTCUT_ENTRIES) {
        expect(entry.id).toBeTruthy()
        expect(entry.i18nKey).toBeTruthy()
        expect(entry.group).toBeTruthy()
        expect(entry.defaultBinding).toBeDefined()
        expect(entry.defaultBinding.key).toBeTruthy()
        expect(entry.defaultBinding.modifiers).toBeDefined()
      }
    })

    it('no duplicate IDs', () => {
      const ids = SHORTCUT_ENTRIES.map((e) => e.id)
      expect(new Set(ids).size).toBe(ids.length)
    })

    it('all IDs follow dot-notation', () => {
      for (const entry of SHORTCUT_ENTRIES) {
        expect(entry.id).toMatch(/^[a-z]+\.[a-zA-Z]+$/)
      }
    })

    it('all groups are in SHORTCUT_GROUP_ORDER', () => {
      const groups = new Set(SHORTCUT_ENTRIES.map((e) => e.group))
      for (const group of groups) {
        expect(SHORTCUT_GROUP_ORDER).toContain(group)
      }
    })

    it('has entries in every declared group', () => {
      for (const group of SHORTCUT_GROUP_ORDER) {
        const entries = SHORTCUT_ENTRIES.filter((e) => e.group === group)
        expect(entries.length).toBeGreaterThan(0)
      }
    })

    it('only lists shortcuts that a runtime owner reads back', () => {
      // A registry row with no owner is a settings row that silently does
      // nothing. nav.goTo*/nav.newTask/editor.save were exactly that.
      const ids = SHORTCUT_ENTRIES.map((e) => e.id)

      expect(ids).not.toContain('nav.newTask')
      expect(ids).not.toContain('nav.goToInbox')
      expect(ids).not.toContain('nav.goToNotes')
      expect(ids).not.toContain('nav.goToTasks')
      expect(ids).not.toContain('editor.save')
    })

    it('every rebindable shortcut has a runtime owner: a binding reader or a command owner', () => {
      const rendererRoot = join(dirname(fileURLToPath(import.meta.url)), '..')
      const sources: string[] = []
      const walk = (dir: string): void => {
        for (const entry of readdirSync(dir, { withFileTypes: true })) {
          const path = join(dir, entry.name)
          if (entry.isDirectory()) walk(path)
          else if (/\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name)) {
            sources.push(readFileSync(path, 'utf8'))
          }
        }
      }
      walk(rendererRoot)
      const corpus = sources.join('\n')

      const unowned = SHORTCUT_ENTRIES.filter((entry) => entry.rebindable !== false)
        .map((entry) => entry.id)
        .filter(
          (id) =>
            !corpus.includes(`useShortcutBinding('${id}')`) &&
            !corpus.includes(`useAppCommands('${COMMANDS[id].owner}'`) &&
            !corpus.includes(`useTabCommands('${COMMANDS[id].owner}'`)
        )

      expect(unowned).toEqual([])
    })

    it('uses the search chord the app actually listens for', () => {
      // Meta+F is find-in-page, never global search.
      const search = SHORTCUT_ENTRIES.find((entry) => entry.id === 'nav.search')

      expect(search?.defaultBinding).toEqual({ key: 'k', modifiers: { meta: true } })
    })

    it('marks editor formatting keys as owned by the editor', () => {
      for (const id of ['editor.bold', 'editor.italic', 'editor.underline']) {
        expect(SHORTCUT_ENTRIES.find((entry) => entry.id === id)?.rebindable).toBe(false)
      }
    })

    it('uses Meta/Ctrl+B as the default sidebar toggle shortcut', () => {
      const toggleSidebar = SHORTCUT_ENTRIES.find((entry) => entry.id === 'view.toggleSidebar')

      expect(toggleSidebar?.defaultBinding).toEqual({ key: 'b', modifiers: { meta: true } })
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
      id: 'nav.newNote',
      i18nKey: 'test.shortcut',
      group: 'navigation',
      defaultBinding: { key: 'n', modifiers: { meta: true } },
      rebindable: true
    }

    it('returns default when no override', () => {
      expect(resolveBinding(entry, {})).toEqual(entry.defaultBinding)
    })

    it('returns override when present', () => {
      const override: ShortcutBinding = { key: 'x', modifiers: { meta: true, shift: true } }
      expect(resolveBinding(entry, { 'nav.newNote': override })).toEqual(override)
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
      const conflicting: ShortcutBinding = { key: 'k', modifiers: { meta: true } }
      const conflicts = findConflicts('custom.id', conflicting, {})
      expect(conflicts.length).toBeGreaterThan(0)
      expect(conflicts[0]).toMatchObject({
        kind: 'command',
        conflictingId: 'nav.search',
        conflictingI18nKey: 'nav.search'
      })
    })

    describe('with folder new-note shortcuts', () => {
      const chord: ShortcutBinding = { key: '9', modifiers: { meta: true, alt: true } }
      const folderNoteShortcuts = [{ folder: 'Work', binding: chord }]

      it('flags a command that takes the chord of a folder shortcut', () => {
        expect(findConflicts('nav.newNote', chord, {}, folderNoteShortcuts)).toEqual([
          { kind: 'folder', conflictingId: folderNoteShortcutId('Work'), folder: 'Work' }
        ])
      })

      it('flags another folder shortcut but never the folder being edited', () => {
        expect(findConflicts(folderNoteShortcutId('Work'), chord, {}, folderNoteShortcuts)).toEqual(
          []
        )
        expect(findConflicts(folderNoteShortcutId('Home'), chord, {}, folderNoteShortcuts)).toEqual(
          [{ kind: 'folder', conflictingId: folderNoteShortcutId('Work'), folder: 'Work' }]
        )
      })

      it('keeps a folder shortcut off an editor key, which fires inside the editor too', () => {
        const bold = SHORTCUT_ENTRIES.find((e) => e.id === 'editor.bold')!
        const conflicts = findConflicts(folderNoteShortcutId('Work'), bold.defaultBinding, {})
        expect(conflicts.some((c) => c.conflictingId === 'editor.bold')).toBe(true)
      })
    })

    it('does not flag editor formatting keys, which focus resolves at keypress time', () => {
      const bold = SHORTCUT_ENTRIES.find((e) => e.id === 'editor.bold')!
      const conflicts = findConflicts('view.toggleSidebar', bold.defaultBinding, {})

      expect(conflicts.every((c) => c.conflictingId !== 'editor.bold')).toBe(true)
    })

    it('excludes self from conflict check', () => {
      const searchBinding = SHORTCUT_ENTRIES.find((e) => e.id === 'nav.search')!.defaultBinding
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
    it('returns a Map with all groups', () => {
      const grouped = getGroupedShortcuts()
      for (const group of SHORTCUT_GROUP_ORDER) {
        expect(grouped.has(group)).toBe(true)
      }
    })

    it('preserves SHORTCUT_GROUP_ORDER ordering', () => {
      const grouped = getGroupedShortcuts()
      const keys = [...grouped.keys()]
      for (let i = 0; i < SHORTCUT_GROUP_ORDER.length; i++) {
        expect(keys[i]).toBe(SHORTCUT_GROUP_ORDER[i])
      }
    })

    it('every entry is placed in its group', () => {
      const grouped = getGroupedShortcuts()
      let total = 0
      for (const entries of grouped.values()) {
        total += entries.length
      }
      expect(total).toBe(SHORTCUT_ENTRIES.length)
    })

    it('entries within a group match their group field', () => {
      const grouped = getGroupedShortcuts()
      for (const [group, entries] of grouped) {
        for (const entry of entries) {
          expect(entry.group).toBe(group)
        }
      }
    })
  })
})
