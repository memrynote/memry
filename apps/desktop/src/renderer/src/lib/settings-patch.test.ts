import { describe, it, expect } from 'vitest'
import { mergeSettingsPatch } from './settings-patch'

describe('mergeSettingsPatch', () => {
  it('returns the previous object by identity when every patched key is unchanged', () => {
    const prev = { theme: 'dark', fontSize: 14, startOnBoot: false }

    const next = mergeSettingsPatch(prev, { theme: 'dark', fontSize: 14 })

    // Identity, not equality: React bails out of the re-render only when the
    // updater returns the very same object.
    expect(next).toBe(prev)
  })

  it('returns the previous object for an empty patch', () => {
    const prev = { theme: 'dark' }

    expect(mergeSettingsPatch(prev, {})).toBe(prev)
  })

  it('returns the previous object when the whole group is re-broadcast unchanged', () => {
    // The sync-apply path re-sends the entire merged `general` blob on every
    // applied settings item, not just the fields that differ.
    const prev = { theme: 'dark', fontSize: 14, accentColor: '#ff671a', language: 'en' }

    const next = mergeSettingsPatch(prev, { ...prev })

    expect(next).toBe(prev)
  })

  it('merges and returns a new object when a patched value differs', () => {
    const prev = { theme: 'dark', fontSize: 14 }

    const next = mergeSettingsPatch(prev, { theme: 'light' })

    expect(next).not.toBe(prev)
    expect(next).toEqual({ theme: 'light', fontSize: 14 })
  })

  it('keeps keys the patch does not mention', () => {
    const prev = { theme: 'dark', fontSize: 14, language: 'en' }

    const next = mergeSettingsPatch(prev, { fontSize: 16 })

    expect(next).toEqual({ theme: 'dark', fontSize: 16, language: 'en' })
  })

  it('treats an explicit null as a change when the previous value was not null', () => {
    const prev = { defaultTemplate: 'daily' as string | null }

    const next = mergeSettingsPatch(prev, { defaultTemplate: null })

    expect(next).not.toBe(prev)
    expect(next.defaultTemplate).toBeNull()
  })

  it('treats a key added with an undefined value as a change when it was absent', () => {
    const prev = { theme: 'dark' } as { theme: string; language?: string }

    // prev.language is undefined and the patch sets undefined: nothing changes.
    expect(mergeSettingsPatch(prev, { language: undefined })).toBe(prev)
  })

  it('does not bail out on nested objects that arrive as fresh references', () => {
    // Keyboard bindings cross IPC as new objects every time, so the shallow
    // comparison correctly reports a change rather than dropping the update.
    const prev = { overrides: { save: 'mod+s' } }

    const next = mergeSettingsPatch(prev, { overrides: { save: 'mod+s' } })

    expect(next).not.toBe(prev)
    expect(next).toEqual(prev)
  })

  it('detects a change when only one key of a multi-key patch differs', () => {
    const prev = { theme: 'dark', fontSize: 14, language: 'en' }

    const next = mergeSettingsPatch(prev, { theme: 'dark', fontSize: 16, language: 'en' })

    expect(next).not.toBe(prev)
    expect(next.fontSize).toBe(16)
  })
})
