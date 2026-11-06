// An outside edit of the open day reaches its editor unless the day holds typing not sent yet
// (#3967): one that came while a save ran, and one right after another outside edit. Missed,
// the next keystroke saves the editor's old text over it.
import { act, renderHook, waitFor } from '@testing-library/react'
import type { QueryClient } from '@tanstack/react-query'
import { QueryClientProvider } from '@tanstack/react-query'
import type { ReactNode } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  cleanupHookTestEnvironment,
  createMockJournalEntry,
  createTestQueryClient,
  setupHookTestEnvironment
} from '@tests/utils/hook-test-wrapper'
import type { JournalEntry } from '../../../preload/index.d'
import { useJournalEntry } from './use-journal-entry'

vi.mock('@/services/templates-service', () => ({ getTemplate: vi.fn() }))
vi.mock('react-i18next', () => ({
  getI18n: () => ({
    language: 'en-US',
    getFixedT: () => (key: string) => key
  })
}))
vi.mock('@/lib/logger', () => ({
  createLogger: () => ({ error: vi.fn(), warn: vi.fn(), info: vi.fn() })
}))

const DAY = '2026-05-10'
const KEY = ['journal', 'entries', DAY]

type Listener = (event: unknown) => void

describe('useJournalEntry: outside edits of the open day', () => {
  let queryClient: QueryClient
  let updated: Listener = () => {}
  let dropped: () => void = () => {}
  let getEntry: ReturnType<typeof vi.fn>
  let updateEntry: ReturnType<typeof vi.fn>
  /** The day's file, as a read answers it. */
  let file: string

  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  )

  const outsideEdit = (content: string): void => {
    file = content
    act(() => {
      updated({
        date: DAY,
        entry: createMockJournalEntry({ date: DAY, content }),
        source: 'external'
      })
    })
  }

  /** The next save waits for `finish`, which answers with the text the save wrote. */
  const holdNextSave = (): { finish: (answer?: string) => Promise<void> } => {
    let resolve: (entry: JournalEntry) => void = () => {}
    let sent = ''
    updateEntry.mockImplementationOnce(
      // oxlint-disable-next-line typescript/no-misused-promises -- mockImplementation is typed as a void-returning callback; resolving a Promise is what the mocked IPC method does
      (input: { date: string; content?: string }) =>
        new Promise<JournalEntry>((done) => {
          sent = input.content ?? file
          resolve = done
        })
    )
    return {
      finish: async (answer) => {
        await act(async () => {
          resolve(createMockJournalEntry({ date: DAY, content: answer ?? sent }))
          for (let i = 0; i < 10; i++) await Promise.resolve()
        })
      }
    }
  }

  const mount = async () => {
    const hook = renderHook(() => useJournalEntry(DAY), { wrapper })
    await waitFor(() => expect(hook.result.current.loadedForDate).toBe(DAY))
    return hook.result
  }

  const startSave = async (result: Awaited<ReturnType<typeof mount>>, content: string) => {
    act(() => {
      result.current.updateContent(content)
    })
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_000)
    })
    expect(updateEntry).toHaveBeenLastCalledWith({ date: DAY, content })
  }

  beforeEach(() => {
    vi.useFakeTimers()
    queryClient = createTestQueryClient()
    setupHookTestEnvironment()
    file = 'Existing'
    const api = window.api as unknown as Record<string, ReturnType<typeof vi.fn>>
    api.onJournalEntryUpdated.mockImplementation((cb: Listener) => {
      updated = cb
      return vi.fn()
    })
    api.onJournalEventsDropped.mockImplementation((cb: () => void) => {
      dropped = cb
      return vi.fn()
    })
    getEntry = window.api.journal.getEntry as ReturnType<typeof vi.fn>
    // oxlint-disable-next-line typescript/no-misused-promises -- mockImplementation is typed as a void-returning callback; resolving a Promise is what the mocked IPC method does
    getEntry.mockImplementation(async () => createMockJournalEntry({ date: DAY, content: file }))
    updateEntry = window.api.journal.updateEntry as ReturnType<typeof vi.fn>
    // oxlint-disable-next-line typescript/no-misused-promises -- mockImplementation is typed as a void-returning callback; resolving a Promise is what the mocked IPC method does
    updateEntry.mockImplementation((input: { date: string; content?: string }) => {
      if (input.content !== undefined) file = input.content
      return Promise.resolve(createMockJournalEntry({ date: input.date, content: file }))
    })
  })

  afterEach(() => {
    queryClient.clear()
    cleanupHookTestEnvironment()
    vi.useRealTimers()
    vi.clearAllMocks()
  })

  describe('an outside edit that came while a save ran', () => {
    it('reaches the editor once the save ends, when it landed after the save wrote', async () => {
      const result = await mount()
      const save = holdNextSave()
      await startSave(result, 'Typed in the app.')
      file = 'Typed in the app.'
      outsideEdit('Rewritten outside.')
      expect(result.current.externalUpdateCount).toBe(0)

      // The reply was read after the save's turn, so it already says the outside text, which
      // the editor does not have.
      await save.finish('Rewritten outside.')

      await waitFor(() => expect(result.current.externalUpdateCount).toBe(1))
      expect(queryClient.getQueryData<JournalEntry>(KEY)?.content).toBe('Rewritten outside.')
      expect(result.current.isDirty).toBe(false)
    })

    // Rust sends the save's own event before its reply, but Tauri does not order the two.
    it('reaches the editor when the save own event lands after its reply', async () => {
      let created: Listener = () => {}
      const api = window.api as unknown as Record<string, ReturnType<typeof vi.fn>>
      api.onJournalEntryCreated.mockImplementation((cb: Listener) => {
        created = cb
        return vi.fn()
      })
      const result = await mount()
      const save = holdNextSave()
      await startSave(result, 'Typed in the app.')
      outsideEdit('Rewritten outside.')
      let answerRead: () => void = () => {}
      getEntry.mockImplementationOnce(
        // oxlint-disable-next-line typescript/no-misused-promises -- mockImplementation is typed as a void-returning callback; resolving a Promise is what the mocked IPC method does
        () =>
          new Promise<JournalEntry>((resolve) => {
            answerRead = () => resolve(createMockJournalEntry({ date: DAY, content: file }))
          })
      )

      await save.finish('Typed in the app.')
      act(() => {
        created({
          date: DAY,
          entry: createMockJournalEntry({ date: DAY, content: 'Typed in the app.' })
        })
      })
      await act(async () => {
        answerRead()
        for (let i = 0; i < 10; i++) await Promise.resolve()
      })

      expect(result.current.externalUpdateCount).toBe(1)
      expect(queryClient.getQueryData<JournalEntry>(KEY)?.content).toBe('Rewritten outside.')
    })

    it('leaves the editor as it is when the save wrote over it', async () => {
      const result = await mount()
      const save = holdNextSave()
      await startSave(result, 'Typed in the app.')
      outsideEdit('Rewritten outside.')
      // The save landed after the outside edit: the file holds the typing.
      file = 'Typed in the app.'

      await save.finish()
      await act(async () => {
        await vi.runOnlyPendingTimersAsync()
      })

      expect(result.current.externalUpdateCount).toBe(0)
      expect(queryClient.getQueryData<JournalEntry>(KEY)?.content).toBe('Typed in the app.')
    })

    it('stays out of the editor when typing came during the save, which is saved over it', async () => {
      const result = await mount()
      const save = holdNextSave()
      await startSave(result, 'Typed in the app.')
      outsideEdit('Rewritten outside.')
      act(() => {
        result.current.updateContent('Typed in the app. And more.')
      })

      await save.finish('Typed in the app.')
      await act(async () => {
        await vi.advanceTimersByTimeAsync(1_000)
      })

      expect(result.current.externalUpdateCount).toBe(0)
      expect(updateEntry).toHaveBeenLastCalledWith({
        date: DAY,
        content: 'Typed in the app. And more.'
      })
    })

    it('reaches the day the page moved to while the last day ran its save', async () => {
      const NEXT = '2026-05-11'
      const hook = renderHook(({ date }) => useJournalEntry(date), {
        wrapper,
        initialProps: { date: DAY }
      })
      await waitFor(() => expect(hook.result.current.loadedForDate).toBe(DAY))
      const save = holdNextSave()
      await startSave(hook.result, 'Typed in the app.')
      hook.rerender({ date: NEXT })
      await waitFor(() => expect(hook.result.current.loadedForDate).toBe(NEXT))
      getEntry.mockResolvedValue(createMockJournalEntry({ date: NEXT, content: 'Next outside.' }))
      act(() => {
        updated({
          date: NEXT,
          entry: createMockJournalEntry({ date: NEXT, content: 'Next outside.' }),
          source: 'external'
        })
      })

      await save.finish()

      await waitFor(() => expect(hook.result.current.externalUpdateCount).toBe(1))
      expect(hook.result.current.entry?.content).toBe('Next outside.')
    })

    it('is read again after the save when only a dropped-events signal told of it', async () => {
      const result = await mount()
      const save = holdNextSave()
      await startSave(result, 'Typed in the app.')
      file = 'Rewritten outside.'
      act(() => {
        dropped()
      })

      await save.finish('Typed in the app.')

      await waitFor(() => expect(result.current.externalUpdateCount).toBe(1))
      expect(queryClient.getQueryData<JournalEntry>(KEY)?.content).toBe('Rewritten outside.')
    })
  })

  describe("the editor's report of the text it was handed", () => {
    it('is not typing: the next outside edit reaches the editor, and nothing saves over it', async () => {
      const result = await mount()
      outsideEdit('First outside.')
      expect(result.current.externalUpdateCount).toBe(1)

      // The reloaded editor reports its text back, spelled as the editor writes it.
      act(() => {
        result.current.updateContent('First outside.\n')
      })
      expect(result.current.isDirty).toBe(false)
      outsideEdit('Second outside.')
      await act(async () => {
        await vi.runOnlyPendingTimersAsync()
      })

      expect(result.current.externalUpdateCount).toBe(2)
      expect(queryClient.getQueryData<JournalEntry>(KEY)?.content).toBe('Second outside.')
      expect(updateEntry).not.toHaveBeenCalled()
      expect(file).toBe('Second outside.')
    })

    it('is typing when it takes back text not saved yet', async () => {
      const result = await mount()
      act(() => {
        result.current.updateContent('Existing and a typo')
        result.current.updateContent('Existing')
      })
      await act(async () => {
        await vi.runOnlyPendingTimersAsync()
      })

      expect(updateEntry).toHaveBeenLastCalledWith({ date: DAY, content: 'Existing' })
    })
  })
})
