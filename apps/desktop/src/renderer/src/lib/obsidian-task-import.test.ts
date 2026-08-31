import { describe, it, expect } from 'vitest'
import { buildObsidianTaskImport } from './obsidian-task-import'

const NOW = new Date('2026-03-04T09:30:00.000Z')

const build = (text: string) => buildObsidianTaskImport(text, NOW)

describe('buildObsidianTaskImport', () => {
  describe('nothing to import', () => {
    it('returns null for a plain line', () => {
      expect(build('Buy milk')).toBeNull()
    })

    it('returns null for a line whose only syntax is a tag', () => {
      expect(build('Buy milk #errand')).toBeNull()
    })

    it('returns null for a line whose only syntax is a block link', () => {
      expect(build('Buy milk ^abc123')).toBeNull()
    })

    it('returns null for a line whose only syntax is a task id', () => {
      expect(build('Buy milk 🆔 abc123')).toBeNull()
    })

    it('returns null for a line whose only syntax is a dependency', () => {
      expect(build('Buy milk ⛔ abc123')).toBeNull()
    })
  })

  describe('priority', () => {
    it('maps 🔺 to 4', () => {
      expect(build('Buy milk 🔺')?.priority).toBe(4)
    })

    it('maps ⏫ to 3', () => {
      expect(build('Buy milk ⏫')?.priority).toBe(3)
    })

    it('maps 🔼 to 2', () => {
      expect(build('Buy milk 🔼')?.priority).toBe(2)
    })

    it('maps 🔽 to 1', () => {
      expect(build('Buy milk 🔽')?.priority).toBe(1)
    })

    it('collapses ⏬ onto 1', () => {
      expect(build('Buy milk ⏬')?.priority).toBe(1)
    })

    it('maps the dataview keyword form', () => {
      expect(build('Buy milk [priority:: highest]')?.priority).toBe(4)
    })

    it('leaves priority null when the line names none', () => {
      expect(build('Buy milk 📅 2026-01-01')?.priority).toBeNull()
    })
  })

  describe('dates', () => {
    it('maps 📅 to dueDate', () => {
      expect(build('Buy milk 📅 2026-01-01')?.dueDate).toBe('2026-01-01')
    })

    it('maps 📆 to dueDate', () => {
      expect(build('Buy milk 📆 2026-01-02')?.dueDate).toBe('2026-01-02')
    })

    it('maps 🗓 to dueDate', () => {
      expect(build('Buy milk 🗓 2026-01-03')?.dueDate).toBe('2026-01-03')
    })

    it('maps 🛫 to startDate', () => {
      expect(build('Buy milk 🛫 2026-01-04')?.startDate).toBe('2026-01-04')
    })

    it('maps ⏳ to startDate when 🛫 is absent', () => {
      expect(build('Buy milk ⏳ 2026-01-05')?.startDate).toBe('2026-01-05')
    })

    it('maps ⌛ to startDate when 🛫 is absent', () => {
      expect(build('Buy milk ⌛ 2026-01-06')?.startDate).toBe('2026-01-06')
    })

    it('lets 🛫 win startDate when both are present', () => {
      expect(build('Buy milk 🛫 2026-01-04 ⏳ 2026-01-05')?.startDate).toBe('2026-01-04')
    })

    it('maps ✅ to a full ISO completedAt', () => {
      expect(build('Buy milk ✅ 2026-01-07')?.completedAt).toBe('2026-01-07T00:00:00.000Z')
    })

    it('leaves completedAt null without a done date', () => {
      expect(build('Buy milk 📅 2026-01-01')?.completedAt).toBeNull()
    })

    it('gives ❌ no column of its own', () => {
      expect(build('Buy milk ❌ 2026-01-08')?.dueDate).toBeNull()
    })

    it('gives ➕ no column of its own', () => {
      expect(build('Buy milk ➕ 2026-01-09')?.startDate).toBeNull()
    })
  })

  describe('recurrence', () => {
    it('maps 🔁 to a repeat config', () => {
      expect(build('Buy milk 🔁 every week')?.repeatConfig).toEqual({
        frequency: 'weekly',
        interval: 1,
        endType: 'never',
        completedCount: 0,
        createdAt: NOW.toISOString()
      })
    })

    it('carries the weekdays a recurrence names', () => {
      expect(build('Buy milk 🔁 every monday, friday')?.repeatConfig?.daysOfWeek).toEqual([1, 5])
    })

    it('honours an interval', () => {
      expect(build('Buy milk 🔁 every 3 days')?.repeatConfig?.interval).toBe(3)
    })

    it('repeats from the due date by default', () => {
      expect(build('Buy milk 🔁 every week')?.repeatFrom).toBe('due')
    })

    it('repeats from completion when the rule says "when done"', () => {
      expect(build('Buy milk 🔁 every week when done')?.repeatFrom).toBe('completion')
    })

    it('leaves repeatConfig null when the rule is not understood', () => {
      expect(build('Buy milk 🔁 every 3 fortnights')?.repeatConfig).toBeNull()
    })

    it('leaves repeatFrom null when the rule is not understood', () => {
      expect(build('Buy milk 🔁 every 3 fortnights')?.repeatFrom).toBeNull()
    })
  })

  describe('title and tags', () => {
    it('strips every recognised field from the title', () => {
      expect(build('Buy milk 📅 2026-01-01 ⏫ 🔁 every week')?.title).toBe('Buy milk')
    })

    it('keeps tags inline in the title', () => {
      expect(build('Buy milk #Errand 📅 2026-01-01 #shop')?.title).toBe('Buy milk #Errand #shop')
    })

    it('lists the tags without their sigil, casing kept', () => {
      expect(build('Buy milk #Errand 📅 2026-01-01 #shop')?.tags).toEqual(['Errand', 'shop'])
    })

    it('lists no tags for an untagged line', () => {
      expect(build('Buy milk 📅 2026-01-01')?.tags).toEqual([])
    })
  })

  describe('preserved original line', () => {
    it('keeps the line even when every field found a home', () => {
      const text = 'Buy milk 📅 2026-01-01 ⏫ 🔁 every week'
      expect(build(text)?.description).toBe(text)
    })

    it('keeps the line when a scheduled date cannot reach startDate', () => {
      const text = 'Buy milk 🛫 2026-01-04 ⏳ 2026-01-05'
      expect(build(text)?.description).toBe(text)
    })

    it('keeps the line for a cancelled date', () => {
      const text = 'Buy milk ❌ 2026-01-08'
      expect(build(text)?.description).toBe(text)
    })

    it('keeps the line for a created date', () => {
      const text = 'Buy milk ➕ 2026-01-09'
      expect(build(text)?.description).toBe(text)
    })

    it('keeps the line for an on-completion action', () => {
      const text = 'Buy milk 🏁 delete'
      expect(build(text)?.description).toBe(text)
    })

    it('keeps the line for a recurrence rule that was not understood', () => {
      const text = 'Buy milk 🔁 every 3 fortnights'
      expect(build(text)?.description).toBe(text)
    })

    it('keeps the line for a lowest priority that collapsed onto low', () => {
      const text = 'Buy milk ⏬'
      expect(build(text)?.description).toBe(text)
    })

    it('keeps the line verbatim, including the spacing the plugin wrote', () => {
      const text = 'Pay rent  [due:: 2026-09-15]  [priority:: high]'
      expect(build(text)?.description).toBe(text)
    })
  })
})
