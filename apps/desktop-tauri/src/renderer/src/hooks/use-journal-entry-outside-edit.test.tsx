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
import { trackRendererError } from '@/lib/telemetry-diagnostics'
import type { JournalEntry } from '../../../preload/index.d'
import { useJournalChangeEvents } from './use-journal-change-events'
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
vi.mock('@/lib/telemetry-diagnostics', () => ({ trackRendererError: vi.fn() }))

const DAY = '2026-05-10'
const NEXT = '2026-05-11'

type Listener = (event?: unknown) => void
const EVENTS = ['onJournalEntryCreated', 'onJournalEntryUpdated', 'onJournalEventsDropped'] as const
type EventName = (typeof EVENTS)[number]

/** The page's hook under the app-level journal listener, as `App.tsx` mounts both. */
function useJournalPage(date: string) {
  useJournalChangeEvents()
  return useJournalEntry(date)
}

describe('useJournalEntry: outside edits of the open day', () => {
  let queryClient: QueryClient
  let listeners: Record<EventName, Listener[]>
  let getEntry: ReturnType<typeof vi.fn>
  let updateEntry: ReturnType<typeof vi.fn>
  /** Each day's file, as a read answers it. */
  let files: Record<string, string>

  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  )

  const emit = (name: EventName, event?: unknown): void => {
    act(() => {
      for (const listener of listeners[name]) listener(event)
    })
  }

  const settle = async (): Promise<void> => {
    await act(async () => {
      for (let i = 0; i < 20; i++) await Promise.resolve()
    })
  }

  const outsideEdit = (content: string, date = DAY): void => {
    files[date] = content
    emit('onJournalEntryUpdated', {
      date,
      entry: createMockJournalEntry({ date, content }),
      source: 'external'
    })
  }

  /** The next save waits for `finish`, which answers with the text the save wrote. */
  const holdNextSave = (): { finish: (answer?: string) => Promise<void> } => {
    let resolve: (entry: JournalEntry) => void = () => {}
    let input: { date: string; content?: string } = { date: DAY }
    updateEntry.mockImplementationOnce(
      // oxlint-disable-next-line typescript/no-misused-promises -- mockImplementation is typed as a void-returning callback; resolving a Promise is what the mocked IPC method does
      (given: { date: string; content?: string }) =>
        new Promise<JournalEntry>((done) => {
          input = given
          resolve = done
        })
    )
    return {
      finish: async (answer) => {
        const content = answer ?? input.content ?? files[input.date]
        await act(async () => {
          resolve(createMockJournalEntry({ date: input.date, content }))
          for (let i = 0; i < 20; i++) await Promise.resolve()
        })
      }
    }
  }

  /** The next read of `date` waits for the returned function, which answers what the file says. */
  const holdNextRead = (date = DAY): (() => Promise<void>) => {
    let answer: () => void = () => {}
    getEntry.mockImplementationOnce(
      // oxlint-disable-next-line typescript/no-misused-promises -- mockImplementation is typed as a void-returning callback; resolving a Promise is what the mocked IPC method does
      () =>
        new Promise<JournalEntry>((resolve) => {
          const content = files[date]
          answer = () => resolve(createMockJournalEntry({ date, content }))
        })
    )
    return async () => {
      answer()
      await settle()
    }
  }

  /** Every read waits until `release`, which answers each with `content`. */
  const holdReads = (): { release: (content: string) => Promise<void> } => {
    const waiting: Array<(entry: JournalEntry) => void> = []
    const reads: Array<string> = []
    getEntry.mockImplementation(
      // oxlint-disable-next-line typescript/no-misused-promises -- mockImplementation is typed as a void-returning callback; resolving a Promise is what the mocked IPC method does
      (date: string) =>
        new Promise<JournalEntry>((resolve) => {
          reads.push(date)
          waiting.push(resolve)
        })
    )
    return {
      release: async (content) => {
        // oxlint-disable-next-line typescript/no-misused-promises -- mockImplementation is typed as a void-returning callback; resolving a Promise is what the mocked IPC method does
        getEntry.mockImplementation(readFile)
        waiting.forEach((resolve, i) =>
          resolve(createMockJournalEntry({ date: reads[i], content }))
        )
        await settle()
      }
    }
  }

  const readFile = async (date: string): Promise<JournalEntry> =>
    createMockJournalEntry({ date, content: files[date] })

  const mount = async (date = DAY) => {
    const hook = renderHook((props: { date: string }) => useJournalPage(props.date), {
      wrapper,
      initialProps: { date }
    })
    await waitFor(() => expect(hook.result.current.loadedForDate).toBe(date))
    await settle()
    return hook
  }

  const openDay = async (hook: Awaited<ReturnType<typeof mount>>, date: string) => {
    hook.rerender({ date })
    await waitFor(() => expect(hook.result.current.loadedForDate).toBe(date))
    await settle()
  }

  const startSave = async (
    result: Awaited<ReturnType<typeof mount>>['result'],
    content: string
  ): Promise<void> => {
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
    files = { [DAY]: 'Existing', [NEXT]: 'Next day' }
    listeners = { onJournalEntryCreated: [], onJournalEntryUpdated: [], onJournalEventsDropped: [] }
    const api = window.api as unknown as Record<string, ReturnType<typeof vi.fn>>
    for (const name of EVENTS) {
      api[name].mockImplementation((cb: Listener) => {
        listeners[name].push(cb)
        return vi.fn()
      })
    }
    getEntry = window.api.journal.getEntry as ReturnType<typeof vi.fn>
    // oxlint-disable-next-line typescript/no-misused-promises -- mockImplementation is typed as a void-returning callback; resolving a Promise is what the mocked IPC method does
    getEntry.mockImplementation(readFile)
    updateEntry = window.api.journal.updateEntry as ReturnType<typeof vi.fn>
    // oxlint-disable-next-line typescript/no-misused-promises -- mockImplementation is typed as a void-returning callback; resolving a Promise is what the mocked IPC method does
    updateEntry.mockImplementation((input: { date: string; content?: string }) => {
      if (input.content !== undefined) files[input.date] = input.content
      return Promise.resolve(
        createMockJournalEntry({ date: input.date, content: files[input.date] })
      )
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
      const { result } = await mount()
      const save = holdNextSave()
      await startSave(result, 'Typed in the app.')
      outsideEdit('Rewritten outside.')
      expect(result.current.externalUpdateCount).toBe(0)

      // The reply was read after the save's turn, so it already says the outside text, which
      // the editor does not have.
      await save.finish('Rewritten outside.')

      await waitFor(() => expect(result.current.externalUpdateCount).toBe(1))
      expect(result.current.entry?.content).toBe('Rewritten outside.')
      expect(result.current.isDirty).toBe(false)
      // The reloaded editor reports the text it was handed: nothing to save.
      act(() => {
        result.current.updateContent('Rewritten outside.')
      })
      expect(result.current.isDirty).toBe(false)
    })

    // Rust sends the save's own event before its reply, but Tauri does not order the two.
    it('reaches the editor when the save own event lands after its reply', async () => {
      const { result } = await mount()
      const save = holdNextSave()
      await startSave(result, 'Typed in the app.')
      outsideEdit('Rewritten outside.')
      const answerRead = holdNextRead()

      await save.finish('Typed in the app.')
      emit('onJournalEntryCreated', {
        date: DAY,
        entry: createMockJournalEntry({ date: DAY, content: 'Typed in the app.' })
      })
      await answerRead()

      await waitFor(() => expect(result.current.externalUpdateCount).toBe(1))
      expect(result.current.entry?.content).toBe('Rewritten outside.')
    })

    it('leaves the editor as it is when the save wrote over it', async () => {
      const { result } = await mount()
      const save = holdNextSave()
      await startSave(result, 'Typed in the app.')
      outsideEdit('Rewritten outside.')
      // The save landed after the outside edit: the file holds the typing.
      files[DAY] = 'Typed in the app.'

      await save.finish()
      await act(async () => {
        await vi.runOnlyPendingTimersAsync()
      })

      expect(result.current.externalUpdateCount).toBe(0)
      expect(result.current.entry?.content).toBe('Typed in the app.')
    })

    it('stays out of the editor when typing came during the save, which is saved over it', async () => {
      const { result } = await mount()
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

    // A tags save never writes the text: its reply is the day as read after it.
    it('reaches the editor after a tags save whose reply already holds it', async () => {
      const { result } = await mount()
      const save = holdNextSave()
      act(() => {
        result.current.updateTags(['kept'])
      })
      await waitFor(() =>
        expect(updateEntry).toHaveBeenLastCalledWith({ date: DAY, tags: ['kept'] })
      )
      outsideEdit('Rewritten outside.')

      await save.finish('Rewritten outside.')

      await waitFor(() => expect(result.current.externalUpdateCount).toBe(1))
      expect(result.current.entry?.content).toBe('Rewritten outside.')
    })

    it('is read again after the save when only a dropped-events signal told of it', async () => {
      const { result } = await mount()
      const save = holdNextSave()
      await startSave(result, 'Typed in the app.')
      files[DAY] = 'Rewritten outside.'
      emit('onJournalEventsDropped')

      await save.finish('Typed in the app.')

      await waitFor(() => expect(result.current.externalUpdateCount).toBe(1))
      expect(result.current.entry?.content).toBe('Rewritten outside.')
    })

    // The app-level listener reads the day into the cache on the event, ahead of the editor.
    it('reaches the day the page moved to while the last day ran its save', async () => {
      const hook = await mount()
      const save = holdNextSave()
      await startSave(hook.result, 'Typed in the app.')
      hook.rerender({ date: NEXT })
      await waitFor(() => expect(hook.result.current.loadedForDate).toBe(NEXT))
      outsideEdit('Next outside.', NEXT)
      await settle()
      // The edit is the new day's, which no save holds: it reaches the editor at once.
      expect(hook.result.current.externalUpdateCount).toBe(1)

      await save.finish()
      await settle()

      expect(hook.result.current.externalUpdateCount).toBe(1)
      expect(hook.result.current.entry?.content).toBe('Next outside.')
    })

    it('reaches the day the page moved to on a dropped-events signal during that save', async () => {
      const hook = await mount()
      const save = holdNextSave()
      await startSave(hook.result, 'Typed in the app.')
      hook.rerender({ date: NEXT })
      await waitFor(() => expect(hook.result.current.loadedForDate).toBe(NEXT))
      files[NEXT] = 'Next outside.'
      emit('onJournalEventsDropped')
      await settle()
      expect(hook.result.current.externalUpdateCount).toBe(1)

      await save.finish()
      await settle()

      expect(hook.result.current.externalUpdateCount).toBe(1)
      expect(hook.result.current.entry?.content).toBe('Next outside.')
    })

    it('leaves a newer outside edit in the editor when the read after the save lands late', async () => {
      const { result } = await mount()
      const save = holdNextSave()
      await startSave(result, 'Typed in the app.')
      outsideEdit('First outside.')
      const answerRead = holdNextRead()
      await save.finish()
      outsideEdit('Second outside.')
      expect(result.current.externalUpdateCount).toBe(1)

      // The read began before the second edit and answers the first.
      files[DAY] = 'First outside.'
      await answerRead()

      expect(result.current.externalUpdateCount).toBe(1)
      expect(result.current.entry?.content).toBe('Second outside.')
    })
  })

  // The page opens a cached day on the cache's text. An outside edit made while it showed
  // another day sent it no event: `useJournalChangeEvents` only marks that day's query stale.
  describe('a day the page opens from its cache', () => {
    it('takes an outside edit made to the prefetched next day', async () => {
      const hook = await mount()
      outsideEdit('Edited outside.', NEXT)
      await settle()

      await openDay(hook, NEXT)

      expect(hook.result.current.externalUpdateCount).toBe(1)
      expect(hook.result.current.entry?.content).toBe('Edited outside.')
    })

    it('takes an outside edit made to the next day while the last day still runs its save', async () => {
      const hook = await mount()
      outsideEdit('Edited outside.', NEXT)
      await settle()
      holdNextSave()
      await startSave(hook.result, 'Typed.')

      await openDay(hook, NEXT)

      expect(hook.result.current.externalUpdateCount).toBe(1)
      expect(hook.result.current.entry?.content).toBe('Edited outside.')
    })

    it('takes a change that sent no event, once the page comes back after its cache went stale', async () => {
      const hook = await mount()
      await openDay(hook, NEXT)
      files[DAY] = 'Changed quietly.'
      await act(async () => {
        await vi.advanceTimersByTimeAsync(31_000)
      })

      await openDay(hook, DAY)

      expect(hook.result.current.externalUpdateCount).toBe(1)
      expect(hook.result.current.entry?.content).toBe('Changed quietly.')
    })

    it('takes an outside edit made after the page left during its save', async () => {
      const hook = await mount()
      const save = holdNextSave()
      await startSave(hook.result, 'Typed.')
      await openDay(hook, NEXT)
      outsideEdit('Edited outside.')
      await settle()
      await save.finish('Typed.')

      await openDay(hook, DAY)

      expect(hook.result.current.externalUpdateCount).toBe(1)
      expect(hook.result.current.entry?.content).toBe('Edited outside.')
    })

    // The editor reopens on the cache, which the save's reply has not reached yet.
    it("takes its own save's text when the page came back to the day during that save", async () => {
      const hook = await mount()
      const save = holdNextSave()
      await startSave(hook.result, 'Typed.')
      // The save wrote; its reply has not come.
      files[DAY] = 'Typed.'
      await openDay(hook, NEXT)
      await openDay(hook, DAY)
      expect(hook.result.current.entry?.content).toBe('Typed.')
      const before = hook.result.current.externalUpdateCount

      await save.finish('Typed.')

      expect(hook.result.current.externalUpdateCount).toBe(before)
      expect(hook.result.current.entry?.content).toBe('Typed.')
    })

    // Typing on the day before the save's reply goes on top of the text being saved, not under
    // the cache's older text: the overwritten file is the app's own write, of which the core
    // keeps no version.
    it('opens on the text being saved, so typing before the reply keeps it', async () => {
      const hook = await mount()
      holdNextSave()
      await startSave(hook.result, 'Existing. Typed before leaving.')
      await openDay(hook, NEXT)

      await openDay(hook, DAY)

      expect(hook.result.current.entry?.content).toBe('Existing. Typed before leaving.')
    })

    // A sidebar note opened in the same tab unmounts the page mid-save, and the day opened
    // again at once: the old page saves the typing made during its save after the new one
    // opened the day on older text. That save's event is not an outside one.
    it('takes the typing an unmounted page saved after this page opened the day', async () => {
      const first = await mount()
      const save = holdNextSave()
      await startSave(first.result, 'First.')
      act(() => {
        first.result.current.updateContent('First. Second.')
      })
      first.unmount()
      const second = await mount()
      expect(second.result.current.entry?.content).toBe('Existing')

      await save.finish()
      expect(updateEntry).toHaveBeenLastCalledWith({ date: DAY, content: 'First. Second.' })
      emit('onJournalEntryUpdated', {
        date: DAY,
        entry: createMockJournalEntry({ date: DAY, content: 'First. Second.' })
      })
      await settle()

      expect(second.result.current.externalUpdateCount).toBe(1)
      expect(second.result.current.entry?.content).toBe('First. Second.')
    })
  })

  // The switch saves the day's typing once: a second write of the same text could go over an
  // outside edit that landed between the two, as a version with no toast.
  describe('a day switch with typing not saved yet', () => {
    const savesOf = (date: string): number =>
      updateEntry.mock.calls.filter(([input]) => (input as { date: string }).date === date).length
    const readsOf = (date: string): number =>
      getEntry.mock.calls.filter(([read]) => read === date).length

    it('saves the typing once', async () => {
      const hook = await mount()
      act(() => {
        hook.result.current.updateContent('Typed.')
      })

      await openDay(hook, NEXT)

      expect(savesOf(DAY)).toBe(1)
      expect(files[DAY]).toBe('Typed.')
    })

    it('does not send the save running again over an outside edit that landed after it wrote', async () => {
      const hook = await mount()
      const save = holdNextSave()
      await startSave(hook.result, 'Typed.')
      outsideEdit('Edited outside.')

      await openDay(hook, NEXT)
      await save.finish('Typed.')

      expect(savesOf(DAY)).toBe(1)
      expect(files[DAY]).toBe('Edited outside.')
    })

    it('sends typing made during the save running', async () => {
      const hook = await mount()
      const running = holdNextSave()
      await startSave(hook.result, 'Typed.')
      act(() => {
        hook.result.current.updateContent('Typed. And more.')
      })

      await openDay(hook, NEXT)
      await running.finish()

      expect(updateEntry).toHaveBeenLastCalledWith({ date: DAY, content: 'Typed. And more.' })
      expect(files[DAY]).toBe('Typed. And more.')
    })

    it('sends the same text typed on another day than the one the save running writes', async () => {
      const hook = await mount()
      holdNextSave()
      await startSave(hook.result, 'Same.')
      await openDay(hook, NEXT)
      act(() => {
        hook.result.current.updateContent('Same.')
      })

      await openDay(hook, DAY)

      expect(savesOf(NEXT)).toBe(1)
      expect(files[NEXT]).toBe('Same.')
    })

    // Typing made during a save goes with the switch's own save. Commands run concurrently: sent
    // at once, it could land before the first, which would leave the older text in the file; the
    // read after the first save could answer the file from before the second wrote, put the
    // editor back on it, and the next save would write that over the typing, the app's own
    // text, of which the core keeps no version (#4088).
    it('sends the switch save once the save running answered, and reads the day after it', async () => {
      const hook = await mount()
      const first = holdNextSave()
      await startSave(hook.result, 'Typed.')
      act(() => {
        hook.result.current.updateContent('Typed. More.')
      })
      const sent = holdNextSave()
      await openDay(hook, NEXT)
      expect(savesOf(DAY)).toBe(1)
      await openDay(hook, DAY)

      files[DAY] = 'Typed.'
      await first.finish('Typed.')

      expect(savesOf(DAY)).toBe(2)
      expect(hook.result.current.externalUpdateCount).toBe(0)
      files[DAY] = 'Typed. More.'
      await sent.finish('Typed. More.')
      // The query tells its observers on a timer.
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0)
      })
      expect(hook.result.current.externalUpdateCount).toBe(0)
      expect(hook.result.current.entry?.content).toBe('Typed. More.')
    })

    // The editor's teardown reports its last edit after the page left the day (#1900), while the
    // day's save may still run: sent at once, the older save could land last and stay in the
    // file, and the read of the day reopened could answer the file from before it (#4088).
    it("sends the editor's late report of the day after the day's save, and reads after it", async () => {
      const hook = await mount()
      const first = holdNextSave()
      await startSave(hook.result, 'Typed.')
      const reportLate = hook.result.current.updateContent
      await openDay(hook, NEXT)
      const late = holdNextSave()
      act(() => {
        reportLate('Typed. Late.')
      })
      await settle()
      expect(savesOf(DAY)).toBe(1)
      await openDay(hook, DAY)

      await first.finish('Typed.')

      expect(updateEntry).toHaveBeenLastCalledWith({ date: DAY, content: 'Typed. Late.' })
      expect(hook.result.current.externalUpdateCount).toBe(0)
      files[DAY] = 'Typed. Late.'
      await late.finish('Typed. Late.')
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0)
      })
      // The editor reopened on the text the switch saved; the late report reaches it as the file's.
      expect(savesOf(DAY)).toBe(2)
      expect(hook.result.current.externalUpdateCount).toBe(1)
      expect(hook.result.current.entry?.content).toBe('Typed. Late.')
    })

    // The read of the reopened day waits for the switch save; typing saved during that wait is
    // newer than what the read can answer. Taken as the read's start, that save would not drop
    // it: the editor would go back to the file before it, and the next keystroke would save over
    // the typing, of which the core keeps no version (#4088).
    it('drops the read of the reopened day when a save started while it waited', async () => {
      const hook = await mount()
      const first = holdNextSave()
      await startSave(hook.result, 'Typed.')
      act(() => {
        hook.result.current.updateContent('Typed. More.')
      })
      const sent = holdNextSave()
      await openDay(hook, NEXT)
      await openDay(hook, DAY)
      files[DAY] = 'Typed.'
      await first.finish('Typed.')
      expect(savesOf(DAY)).toBe(2)

      const again = holdNextSave()
      act(() => {
        hook.result.current.updateContent('Typed. More. Again.')
      })
      await act(async () => {
        await vi.advanceTimersByTimeAsync(1_000)
      })
      expect(savesOf(DAY)).toBe(2)
      const answerRead = holdNextRead()
      files[DAY] = 'Typed. More.'
      await sent.finish('Typed. More.')
      expect(savesOf(DAY)).toBe(3)
      files[DAY] = 'Typed. More. Again.'
      await again.finish('Typed. More. Again.')
      await answerRead()
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0)
      })

      expect(hook.result.current.externalUpdateCount).toBe(0)
      expect(hook.result.current.entry?.content).toBe('Typed. More. Again.')
    })

    // A write that never answers would hold the day's later writes, its reread, and through the
    // save flag every other day's saves, until the app quits (#4088).
    it('sends the later writes when a write of the day never answers', async () => {
      const hook = await mount()
      const first = holdNextSave()
      await startSave(hook.result, 'Typed.')
      act(() => {
        hook.result.current.updateContent('Typed. More.')
      })
      // oxlint-disable-next-line typescript/no-misused-promises -- mockImplementation is typed as a void-returning callback; a Promise that never settles is the write that never answers
      updateEntry.mockImplementationOnce(() => new Promise<JournalEntry>(() => {}))
      await openDay(hook, NEXT)
      await openDay(hook, DAY)
      await first.finish('Typed.')
      expect(savesOf(DAY)).toBe(2)

      act(() => {
        hook.result.current.updateContent('Typed. After.')
      })
      await act(async () => {
        await vi.advanceTimersByTimeAsync(1_000)
      })
      expect(savesOf(DAY)).toBe(2)
      expect(hook.result.current.isSaving).toBe(true)
      await act(async () => {
        await vi.advanceTimersByTimeAsync(10_000)
      })

      expect(updateEntry).toHaveBeenLastCalledWith({ date: DAY, content: 'Typed. After.' })
      expect(hook.result.current.isSaving).toBe(false)
      await openDay(hook, NEXT)
      act(() => {
        hook.result.current.updateContent('Next typed.')
      })
      await act(async () => {
        await vi.advanceTimersByTimeAsync(1_000)
      })
      expect(updateEntry).toHaveBeenLastCalledWith({ date: NEXT, content: 'Next typed.' })
    })

    // The day's own save never answers: the save flag it holds stops every day's saves and keeps
    // the indicator on until the app quits, unless the wait on it ends (#4138).
    it('sends later saves of every day when the day save itself never answers', async () => {
      const hook = await mount()
      // oxlint-disable-next-line typescript/no-misused-promises -- mockImplementation is typed as a void-returning callback; a Promise that never settles is the write that never answers
      updateEntry.mockImplementationOnce(() => new Promise<JournalEntry>(() => {}))
      await startSave(hook.result, 'Typed.')
      act(() => {
        hook.result.current.updateContent('Typed. More.')
      })
      await act(async () => {
        await vi.advanceTimersByTimeAsync(1_000)
      })
      expect(savesOf(DAY)).toBe(1)
      expect(hook.result.current.isSaving).toBe(true)
      expect(trackRendererError).not.toHaveBeenCalled()

      await act(async () => {
        await vi.advanceTimersByTimeAsync(9_000)
      })

      expect(hook.result.current.isSaving).toBe(false)
      expect(trackRendererError).toHaveBeenCalledWith(
        'journal_day_write_timeout',
        expect.objectContaining({
          message: expect.stringMatching(new RegExp(`${DAY}.*10000 ms.*save flag`))
        })
      )
      act(() => {
        hook.result.current.updateContent('Typed. After.')
      })
      await act(async () => {
        await vi.advanceTimersByTimeAsync(1_000)
      })
      expect(updateEntry).toHaveBeenLastCalledWith({ date: DAY, content: 'Typed. After.' })
      expect(hook.result.current.isSaving).toBe(false)
      await openDay(hook, NEXT)
      act(() => {
        hook.result.current.updateContent('Next typed.')
      })
      await act(async () => {
        await vi.advanceTimersByTimeAsync(1_000)
      })
      expect(updateEntry).toHaveBeenLastCalledWith({ date: NEXT, content: 'Next typed.' })
    })

    // The read of a reopened day waits for the day's writes; one that never answers would keep the
    // read, and with it an outside edit of the day, from the editor for good (#4138).
    it('reads the reopened day 10 s on when a write of the day never answers', async () => {
      const hook = await mount()
      const reportLate = hook.result.current.updateContent
      await openDay(hook, NEXT)
      // oxlint-disable-next-line typescript/no-misused-promises -- mockImplementation is typed as a void-returning callback; a Promise that never settles is the write that never answers
      updateEntry.mockImplementationOnce(() => new Promise<JournalEntry>(() => {}))
      act(() => {
        reportLate('Typed. Late.')
      })
      await settle()
      expect(savesOf(DAY)).toBe(1)
      files[DAY] = 'Rewritten outside.'
      await openDay(hook, DAY)
      const readsBefore = readsOf(DAY)
      await act(async () => {
        await vi.advanceTimersByTimeAsync(9_000)
      })
      expect(readsOf(DAY)).toBe(readsBefore)

      await act(async () => {
        await vi.advanceTimersByTimeAsync(1_000)
      })

      expect(readsOf(DAY)).toBe(readsBefore + 1)
      expect(hook.result.current.externalUpdateCount).toBe(1)
      expect(hook.result.current.entry?.content).toBe('Rewritten outside.')
      expect(trackRendererError).toHaveBeenCalledWith(
        'journal_day_write_timeout',
        expect.objectContaining({ message: expect.stringContaining('the read waiting') })
      )
    })

    it('sends the typing again when the save running fails', async () => {
      const hook = await mount()
      let fail: () => void = () => {}
      updateEntry.mockImplementationOnce(
        // oxlint-disable-next-line typescript/no-misused-promises -- mockImplementation is typed as a void-returning callback; rejecting a Promise is what the mocked IPC method does
        () =>
          new Promise<JournalEntry>((_, reject) => {
            fail = () => reject(new Error('write failed'))
          })
      )
      await startSave(hook.result, 'Typed.')

      await openDay(hook, NEXT)
      await act(async () => {
        fail()
        for (let i = 0; i < 20; i++) await Promise.resolve()
      })

      expect(savesOf(DAY)).toBe(2)
      expect(files[DAY]).toBe('Typed.')
    })
  })

  describe('a day the page comes back to', () => {
    // The editor's teardown reports its last edit after the page left the day, which saves it
    // there (#1900). The page came back before the other day loaded: its editor reopened on
    // that save's text, not on the text it reported before leaving.
    it('compares a read with the text its editor reopened on', async () => {
      const hook = await mount()
      act(() => {
        hook.result.current.updateContent('Typed before leaving.')
      })
      const reportLate = hook.result.current.updateContent
      holdReads()
      hook.rerender({ date: '2026-06-01' })
      await settle()
      act(() => {
        reportLate('Typed before leaving, and late.')
      })
      await settle()
      hook.rerender({ date: DAY })
      await waitFor(() => expect(hook.result.current.loadedForDate).toBe(DAY))
      expect(hook.result.current.entry?.content).toBe('Typed before leaving, and late.')
      // oxlint-disable-next-line typescript/no-misused-promises -- mockImplementation is typed as a void-returning callback; resolving a Promise is what the mocked IPC method does
      getEntry.mockImplementation(readFile)

      // An outside edit, missed, puts back the text from before the late report.
      files[DAY] = 'Typed before leaving.'
      emit('onJournalEventsDropped')
      await settle()

      expect(hook.result.current.externalUpdateCount).toBe(1)
      expect(hook.result.current.entry?.content).toBe('Typed before leaving.')
    })
  })

  describe('a dropped-events signal', () => {
    it('keeps the newest of two reads when the older one answers last', async () => {
      const { result } = await mount()
      const first = holdReads()
      emit('onJournalEventsDropped')
      await settle()
      // oxlint-disable-next-line typescript/no-misused-promises -- mockImplementation is typed as a void-returning callback; resolving a Promise is what the mocked IPC method does
      getEntry.mockImplementation(readFile)
      files[DAY] = 'Newer outside.'
      emit('onJournalEventsDropped')
      await settle()
      expect(result.current.externalUpdateCount).toBe(1)

      await first.release('Older outside.')

      expect(result.current.externalUpdateCount).toBe(1)
      expect(result.current.entry?.content).toBe('Newer outside.')
    })
  })

  describe('a dropped-events signal, read twice', () => {
    // The app-level listener refetches the day too. Its answer renders before the page's own
    // read lands, which still compares with the editor's text, not with that refetch.
    it('hands the missed edit over when the app-level refetch renders first', async () => {
      const { result } = await mount()
      const answers: Array<() => void> = []
      getEntry.mockImplementation(
        // oxlint-disable-next-line typescript/no-misused-promises -- mockImplementation is typed as a void-returning callback; resolving a Promise is what the mocked IPC method does
        (date: string) =>
          new Promise<JournalEntry>((resolve) => {
            answers.push(() => resolve(createMockJournalEntry({ date, content: files[date] })))
          })
      )
      files[DAY] = 'Missed outside.'
      emit('onJournalEventsDropped')
      await settle()
      expect(answers).toHaveLength(2)

      const [appRefetch, ownRead] = answers
      await act(async () => {
        appRefetch()
        await vi.advanceTimersByTimeAsync(50)
      })
      expect(result.current.entry?.content).toBe('Missed outside.')
      expect(result.current.externalUpdateCount).toBe(0)
      await act(async () => {
        ownRead()
        await vi.advanceTimersByTimeAsync(50)
      })

      expect(result.current.externalUpdateCount).toBe(1)
    })
  })

  describe('a forced reload', () => {
    // A version restore reloads the day and remounts its editor on the answer.
    it('is the text later reads compare with', async () => {
      const { result } = await mount()
      files[DAY] = 'Restored.'
      await act(async () => {
        await result.current.forceReload()
      })
      expect(result.current.entry?.content).toBe('Restored.')

      emit('onJournalEventsDropped')
      await settle()

      expect(result.current.externalUpdateCount).toBe(0)
    })
  })

  describe("the editor's report of the text it was handed", () => {
    it('is not typing: the next outside edit reaches the editor, and nothing saves over it', async () => {
      const { result } = await mount()
      outsideEdit('First outside.\r\nSecond line.')
      expect(result.current.externalUpdateCount).toBe(1)

      // The reloaded editor reports its text back, spelled as the editor writes it.
      act(() => {
        result.current.updateContent('First outside.\nSecond line.\n')
      })
      expect(result.current.isDirty).toBe(false)
      outsideEdit('Second outside.')
      await act(async () => {
        await vi.runOnlyPendingTimersAsync()
      })

      expect(result.current.externalUpdateCount).toBe(2)
      expect(result.current.entry?.content).toBe('Second outside.')
      expect(updateEntry).not.toHaveBeenCalled()
      expect(files[DAY]).toBe('Second outside.')
    })

    it('is typing when it takes back text not saved yet', async () => {
      const { result } = await mount()
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
