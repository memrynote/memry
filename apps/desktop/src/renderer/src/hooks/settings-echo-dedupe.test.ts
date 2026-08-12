import { describe, it, expect, vi, beforeEach } from 'vitest'
import { renderHook, waitFor, act } from '@testing-library/react'
import { useGeneralSettings } from './use-general-settings'
import { useEditorSettings } from './use-editor-settings'
import { useJournalSettings } from './use-journal-settings'
import { useTabPreferences } from './use-tab-preferences'
import { useInboxPreferences } from './use-inbox-preferences'
import { useKeyboardSettings } from './use-keyboard-settings'
import { useNoteEditorSettings } from './use-note-editor-settings'
import { useCalendarPreferences } from './use-calendar-preferences'

/**
 * `settings:changed` is broadcast to every window including the writer's, and
 * that echo cannot be suppressed at the sender (#1063) — a single window holds
 * many independent instances of the same settings hook and only the one that
 * issued the write applies it optimistically, so the rest converge through the
 * echo. Each subscriber therefore has to make the echo free when it carries
 * nothing new, by merging through `mergeSettingsPatch` so an unchanged payload
 * returns the previous state object and React bails out.
 *
 * Every settings-group hook is checked here rather than only the one that
 * happens to have a test file, because the regression is per-subscriber: a hook
 * that goes back to `{ ...prev, ...value }` re-renders its consumers on every
 * sync apply again, silently.
 */

interface SettingsCase {
  name: string
  getter: string
  key: string
  loaded: Record<string, unknown>
  change: Record<string, unknown>
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  render: () => { settings: any; isLoading: boolean }
  read: (settings: Record<string, unknown>) => unknown
  expected: unknown
}

const CASES: SettingsCase[] = [
  {
    name: 'useGeneralSettings',
    getter: 'getGeneralSettings',
    key: 'general',
    loaded: { theme: 'dark', fontSize: 14, language: 'en' },
    change: { theme: 'light' },
    render: () => useGeneralSettings(),
    read: (s) => s.theme,
    expected: 'light'
  },
  {
    name: 'useEditorSettings',
    getter: 'getEditorSettings',
    key: 'editor',
    loaded: { width: 'normal', toolbarMode: 'floating', spellCheck: false },
    change: { width: 'full' },
    render: () => useEditorSettings(),
    read: (s) => s.width,
    expected: 'full'
  },
  {
    name: 'useJournalSettings',
    getter: 'getJournalSettings',
    key: 'journal',
    loaded: {
      defaultTemplate: null,
      showSchedule: true,
      showTasks: true,
      showAIConnections: true,
      showStatsFooter: false
    },
    change: { showTasks: false },
    render: () => useJournalSettings(),
    read: (s) => s.showTasks,
    expected: false
  },
  {
    name: 'useTabPreferences',
    getter: 'getTabSettings',
    key: 'tabs',
    loaded: { restoreSessionOnStart: true, tabCloseButton: 'hover' },
    change: { tabCloseButton: 'always' },
    render: () => useTabPreferences(),
    read: (s) => s.tabCloseButton,
    expected: 'always'
  },
  {
    name: 'useInboxPreferences',
    getter: 'getInboxSettings',
    key: 'inbox',
    loaded: { reviewReminderEnabled: false, reviewReminderTime: '09:00' },
    change: { reviewReminderTime: '18:30' },
    render: () => useInboxPreferences(),
    read: (s) => s.reviewReminderTime,
    expected: '18:30'
  },
  {
    name: 'useKeyboardSettings',
    getter: 'getKeyboardSettings',
    key: 'keyboard',
    loaded: { overrides: {}, globalCapture: null },
    change: { globalCapture: 'CommandOrControl+Shift+K' },
    render: () => useKeyboardSettings(),
    read: (s) => s.globalCapture,
    expected: 'CommandOrControl+Shift+K'
  },
  {
    name: 'useNoteEditorSettings',
    getter: 'getNoteEditorSettings',
    key: 'noteEditor',
    loaded: { toolbarMode: 'floating' },
    change: { toolbarMode: 'fixed' },
    render: () => useNoteEditorSettings(),
    read: (s) => s.toolbarMode,
    expected: 'fixed'
  },
  {
    name: 'useCalendarPreferences',
    getter: 'getCalendarSettings',
    key: 'calendar',
    loaded: { dayCellClickBehavior: 'journal', calendarPageClickOverride: 'calendar' },
    change: { dayCellClickBehavior: 'calendar' },
    render: () => useCalendarPreferences(),
    read: (s) => s.dayCellClickBehavior,
    expected: 'calendar'
  }
]

describe('settings:changed echo dedupe (#1063)', () => {
  let settingsChangedListener: ((event: { key: string; value: unknown }) => void) | null

  beforeEach(() => {
    settingsChangedListener = null
    ;(window.api.onSettingsChanged as ReturnType<typeof vi.fn>).mockImplementation(
      (cb: (event: { key: string; value: unknown }) => void) => {
        settingsChangedListener = cb
        return () => {
          settingsChangedListener = null
        }
      }
    )
  })

  const mountLoaded = async (
    testCase: SettingsCase
  ): Promise<ReturnType<typeof renderHook<{ settings: unknown; isLoading: boolean }, void>>> => {
    const settingsMock = window.api.settings as Record<string, unknown>
    settingsMock[testCase.getter] = vi.fn().mockResolvedValue({ ...testCase.loaded })

    const rendered = renderHook(() => testCase.render())
    await waitFor(() => {
      expect(rendered.result.current.isLoading).toBe(false)
    })
    return rendered as never
  }

  for (const testCase of CASES) {
    describe(testCase.name, () => {
      it('keeps state identity when the unchanged group is echoed back', async () => {
        const { result } = await mountLoaded(testCase)

        const before = result.current.settings

        act(() => {
          // The sync-apply path re-broadcasts the whole merged group on every
          // applied settings item, not only the fields that differ.
          settingsChangedListener!({ key: testCase.key, value: { ...testCase.loaded } })
        })

        expect(result.current.settings).toBe(before)
      })

      it('still applies an echo that genuinely differs', async () => {
        const { result } = await mountLoaded(testCase)

        act(() => {
          settingsChangedListener!({ key: testCase.key, value: { ...testCase.change } })
        })

        expect(testCase.read(result.current.settings)).toEqual(testCase.expected)
      })

      it('ignores events for other settings groups', async () => {
        const { result } = await mountLoaded(testCase)

        const before = result.current.settings

        act(() => {
          settingsChangedListener!({ key: 'some-other-group', value: { anything: true } })
        })

        expect(result.current.settings).toBe(before)
      })
    })
  }
})
