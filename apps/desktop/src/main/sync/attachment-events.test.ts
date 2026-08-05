import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

const debugSpy = vi.hoisted(() => vi.fn())
const warnSpy = vi.hoisted(() => vi.fn())
const errorSpy = vi.hoisted(() => vi.fn())

vi.mock('../lib/logger', () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: warnSpy,
    error: errorSpy,
    debug: debugSpy
  })
}))

import { attachmentEvents } from './attachment-events'

interface SavedEvent {
  noteId: string
  diskPath: string
}

interface DownloadNeededEvent {
  noteId: string
  attachmentId: string
  diskPath: string
  intoDir?: boolean
}

/**
 * `attachmentEvents` is a process-wide singleton, so every test has to leave the
 * bus empty or the next one inherits its listeners.
 */
beforeEach(() => {
  attachmentEvents.removeAllListeners()
  debugSpy.mockClear()
  warnSpy.mockClear()
  errorSpy.mockClear()
})

afterEach(() => {
  attachmentEvents.removeAllListeners()
})

describe('attachmentEvents — saved', () => {
  it('delivers the saved payload to a registered handler', () => {
    const handler = vi.fn()
    attachmentEvents.onSaved(handler)

    attachmentEvents.emitSaved({ noteId: 'note-1', diskPath: '/vault/attachments/a.png' })

    expect(handler).toHaveBeenCalledTimes(1)
    expect(handler).toHaveBeenCalledWith({
      noteId: 'note-1',
      diskPath: '/vault/attachments/a.png'
    })
  })

  it('delivers synchronously, before emitSaved returns', () => {
    const seen: string[] = []
    attachmentEvents.onSaved(() => seen.push('handler'))

    attachmentEvents.emitSaved({ noteId: 'note-1', diskPath: '/vault/a.png' })
    seen.push('after-emit')

    expect(seen).toEqual(['handler', 'after-emit'])
  })

  it('hands the same object to every listener (no defensive copy)', () => {
    const event: SavedEvent = { noteId: 'note-1', diskPath: '/vault/a.png' }
    const first = vi.fn()
    const second = vi.fn()
    attachmentEvents.onSaved(first)
    attachmentEvents.onSaved(second)

    attachmentEvents.emitSaved(event)

    expect(first.mock.calls[0][0]).toBe(event)
    expect(second.mock.calls[0][0]).toBe(event)
  })

  it('calls listeners in registration order', () => {
    const order: string[] = []
    attachmentEvents.onSaved(() => order.push('first'))
    attachmentEvents.onSaved(() => order.push('second'))

    attachmentEvents.emitSaved({ noteId: 'note-1', diskPath: '/vault/a.png' })

    expect(order).toEqual(['first', 'second'])
  })

  it('offSaved removes exactly the handler it was given', () => {
    const kept = vi.fn()
    const dropped = vi.fn()
    attachmentEvents.onSaved(kept)
    attachmentEvents.onSaved(dropped)

    attachmentEvents.offSaved(dropped)
    attachmentEvents.emitSaved({ noteId: 'note-1', diskPath: '/vault/a.png' })

    expect(kept).toHaveBeenCalledTimes(1)
    expect(dropped).not.toHaveBeenCalled()
    expect(attachmentEvents.listenerCount('saved')).toBe(1)
  })

  it('offSaved with an unregistered handler is a no-op', () => {
    const handler = vi.fn()
    attachmentEvents.onSaved(handler)

    attachmentEvents.offSaved(vi.fn())
    attachmentEvents.emitSaved({ noteId: 'note-1', diskPath: '/vault/a.png' })

    expect(handler).toHaveBeenCalledTimes(1)
  })

  it('logs the noteId only — the absolute host path never reaches the log', () => {
    attachmentEvents.emitSaved({
      noteId: 'note-1',
      diskPath: '/Users/someone/Vault/attachments/note-1/private.png'
    })

    expect(debugSpy).toHaveBeenCalledWith('attachment saved', { noteId: 'note-1' })
    const logged = JSON.stringify(debugSpy.mock.calls)
    expect(logged).not.toContain('/Users/someone')
    expect(logged).not.toContain('private.png')
  })
})

describe('attachmentEvents — download needed', () => {
  it('delivers the download-needed payload to a registered handler', () => {
    const handler = vi.fn()
    attachmentEvents.onDownloadNeeded(handler)

    attachmentEvents.emitDownloadNeeded({
      noteId: 'note-1',
      attachmentId: 'att-1',
      diskPath: '/vault/attachments/note-1',
      intoDir: true
    })

    expect(handler).toHaveBeenCalledTimes(1)
    expect(handler).toHaveBeenCalledWith({
      noteId: 'note-1',
      attachmentId: 'att-1',
      diskPath: '/vault/attachments/note-1',
      intoDir: true
    })
  })

  it('preserves the intoDir flag exactly — it decides file-vs-directory on the far side', () => {
    const handler = vi.fn<(event: DownloadNeededEvent) => void>()
    attachmentEvents.onDownloadNeeded(handler)

    // Embedded-attachment flow: diskPath is the note's attachments DIRECTORY,
    // the filename only exists inside the encrypted manifest.
    attachmentEvents.emitDownloadNeeded({
      noteId: 'note-1',
      attachmentId: 'att-1',
      diskPath: '/vault/attachments/note-1',
      intoDir: true
    })
    // Binary-note flow: diskPath is the exact target FILE.
    attachmentEvents.emitDownloadNeeded({
      noteId: 'note-2',
      attachmentId: 'att-2',
      diskPath: '/vault/Scans/report.pdf'
    })

    expect(handler.mock.calls[0][0].intoDir).toBe(true)
    // Not normalised to `false`: the consumer branches on truthiness, and an
    // accidental `intoDir: true` default would write the blob as a directory.
    expect(handler.mock.calls[1][0].intoDir).toBeUndefined()
    expect('intoDir' in handler.mock.calls[1][0]).toBe(false)
  })

  it('offDownloadNeeded removes exactly the handler it was given', () => {
    const kept = vi.fn()
    const dropped = vi.fn()
    attachmentEvents.onDownloadNeeded(kept)
    attachmentEvents.onDownloadNeeded(dropped)

    attachmentEvents.offDownloadNeeded(dropped)
    attachmentEvents.emitDownloadNeeded({
      noteId: 'note-1',
      attachmentId: 'att-1',
      diskPath: '/vault/attachments/note-1',
      intoDir: true
    })

    expect(kept).toHaveBeenCalledTimes(1)
    expect(dropped).not.toHaveBeenCalled()
  })

  it('logs noteId and attachmentId only — the disk path never reaches the log', () => {
    attachmentEvents.emitDownloadNeeded({
      noteId: 'note-1',
      attachmentId: 'att-1',
      diskPath: '/Users/someone/Vault/attachments/note-1',
      intoDir: true
    })

    expect(debugSpy).toHaveBeenCalledWith('attachment download needed', {
      noteId: 'note-1',
      attachmentId: 'att-1'
    })
    expect(JSON.stringify(debugSpy.mock.calls)).not.toContain('/Users/someone')
    // No listener is registered here, so the drop warning fires too — it is held
    // to the same hygiene rule as the debug line.
    expect(JSON.stringify(warnSpy.mock.calls)).not.toContain('/Users/someone')
  })
})

describe('attachmentEvents — channel isolation', () => {
  it('keeps saved and download-needed on separate channels', () => {
    const saved = vi.fn()
    const download = vi.fn()
    attachmentEvents.onSaved(saved)
    attachmentEvents.onDownloadNeeded(download)

    attachmentEvents.emitSaved({ noteId: 'note-1', diskPath: '/vault/a.png' })

    expect(saved).toHaveBeenCalledTimes(1)
    expect(download).not.toHaveBeenCalled()

    attachmentEvents.emitDownloadNeeded({
      noteId: 'note-1',
      attachmentId: 'att-1',
      diskPath: '/vault/attachments/note-1',
      intoDir: true
    })

    expect(download).toHaveBeenCalledTimes(1)
    expect(saved).toHaveBeenCalledTimes(1)
  })
})

describe('attachmentEvents — failure surfacing', () => {
  it('lets a throwing listener escape to the emitter instead of swallowing it', () => {
    attachmentEvents.onDownloadNeeded(() => {
      throw new Error('could not resolve attachment')
    })

    expect(() =>
      attachmentEvents.emitDownloadNeeded({
        noteId: 'note-1',
        attachmentId: 'att-missing',
        diskPath: '/vault/attachments/note-1',
        intoDir: true
      })
    ).toThrow('could not resolve attachment')
  })

  it('stops delivering to later listeners once an earlier one throws', () => {
    const later = vi.fn()
    attachmentEvents.onDownloadNeeded(() => {
      throw new Error('boom')
    })
    attachmentEvents.onDownloadNeeded(later)

    expect(() =>
      attachmentEvents.emitDownloadNeeded({
        noteId: 'note-1',
        attachmentId: 'att-1',
        diskPath: '/vault/attachments/note-1',
        intoDir: true
      })
    ).toThrow('boom')
    // EventEmitter has no per-listener isolation: one bad consumer silences
    // every consumer registered after it for that emit.
    expect(later).not.toHaveBeenCalled()
  })

  it('warns when a download-needed event is dropped because nothing is listening', () => {
    expect(attachmentEvents.listenerCount('download-needed')).toBe(0)

    // A drop must stay non-fatal, but it must not read like a success either.
    // `unregisterAttachmentHandlers()` calls
    // `removeAllListeners('download-needed')`, so this is the real state during
    // a sync-runtime restart or sign-out/in.
    expect(() =>
      attachmentEvents.emitDownloadNeeded({
        noteId: 'note-1',
        attachmentId: 'att-1',
        diskPath: '/vault/attachments/note-1',
        intoDir: true
      })
    ).not.toThrow()

    expect(warnSpy).toHaveBeenCalledWith(
      'attachment download-needed event dropped: no listener registered',
      { noteId: 'note-1', attachmentId: 'att-1' }
    )
    // Still not an error: the caller retries on the next pull of the note.
    expect(errorSpy).not.toHaveBeenCalled()
  })

  it('warns when a saved event is dropped because nothing is listening', () => {
    expect(attachmentEvents.listenerCount('saved')).toBe(0)

    expect(() =>
      attachmentEvents.emitSaved({ noteId: 'note-1', diskPath: '/vault/a.png' })
    ).not.toThrow()

    expect(warnSpy).toHaveBeenCalledWith('attachment saved event dropped: no listener registered', {
      noteId: 'note-1'
    })
    expect(JSON.stringify(warnSpy.mock.calls)).not.toContain('/vault/a.png')
    expect(errorSpy).not.toHaveBeenCalled()
  })

  it('reports delivery when a listener is registered', () => {
    attachmentEvents.onDownloadNeeded(vi.fn())
    attachmentEvents.onSaved(vi.fn())

    expect(
      attachmentEvents.emitDownloadNeeded({
        noteId: 'note-1',
        attachmentId: 'att-1',
        diskPath: '/vault/attachments/note-1',
        intoDir: true
      })
    ).toBe(true)
    expect(attachmentEvents.emitSaved({ noteId: 'note-1', diskPath: '/vault/a.png' })).toBe(true)
    expect(warnSpy).not.toHaveBeenCalled()
  })

  it('emitDownloadNeeded tells the caller whether the event was delivered', () => {
    // `EventEmitter.emit` already returns `false` when there is no listener,
    // but the wrapper declares `: void` and discards it. The caller
    // (`requestEmbeddedAttachmentDownloads` in item-handlers/note-handler.ts)
    // adds `"<noteId>:<attachmentId>"` to its `requestedAttachmentDownloads`
    // dedupe set BEFORE emitting and never removes it, so an event dropped
    // here is never re-requested for the lifetime of the process — the image
    // simply never arrives, with nothing above debug level in the log.
    // Returning the boolean is the minimal fix that lets the caller retry.
    const delivered = attachmentEvents.emitDownloadNeeded({
      noteId: 'note-1',
      attachmentId: 'att-1',
      diskPath: '/vault/attachments/note-1',
      intoDir: true
    })

    expect(delivered).toBe(false)
  })

  it('emitSaved tells the caller whether the event was delivered', () => {
    // Same discarded signal on the upload side: the vault watcher emits `saved`
    // for every new attachment file. With no listener the upload intent is never
    // even written to the outbox, so the blob is never pushed.
    const delivered = attachmentEvents.emitSaved({ noteId: 'note-1', diskPath: '/vault/a.png' })

    expect(delivered).toBe(false)
  })
})
