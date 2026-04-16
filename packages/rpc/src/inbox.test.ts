import { describe, expect, it } from 'vitest'
import { InboxChannels } from '../../contracts/src/ipc-channels.ts'
import { inboxRpc } from './inbox.ts'

describe('inboxRpc domain shape', () => {
  it('has name "inbox"', () => {
    expect(inboxRpc.name).toBe('inbox')
  })

  it('declares the full capture + file + bulk surface (>= 35 methods)', () => {
    expect(Object.keys(inboxRpc.methods).length).toBeGreaterThanOrEqual(35)
  })

  it('every method spec has channel, mode, and arg arrays', () => {
    for (const [key, method] of Object.entries(inboxRpc.methods)) {
      expect(method.channel, `method ${key}`).toBeTypeOf('string')
      expect(['invoke', 'sync'], `method ${key}`).toContain(method.mode)
      expect(Array.isArray(method.params)).toBe(true)
      expect(Array.isArray(method.invokeArgs)).toBe(true)
    }
  })

  it('method channels are unique', () => {
    const channels = Object.values(inboxRpc.methods).map((m) => m.channel)
    expect(new Set(channels).size).toBe(channels.length)
  })

  it('event channels are unique', () => {
    const channels = Object.values(inboxRpc.events).map((e) => e.channel)
    expect(new Set(channels).size).toBe(channels.length)
  })

  it('wires capture methods to InboxChannels.invoke', () => {
    expect(inboxRpc.methods.captureText.channel).toBe(InboxChannels.invoke.CAPTURE_TEXT)
    expect(inboxRpc.methods.captureLink.channel).toBe(InboxChannels.invoke.CAPTURE_LINK)
    expect(inboxRpc.methods.captureImage.channel).toBe(InboxChannels.invoke.CAPTURE_IMAGE)
    expect(inboxRpc.methods.captureVoice.channel).toBe(InboxChannels.invoke.CAPTURE_VOICE)
    expect(inboxRpc.methods.captureClip.channel).toBe(InboxChannels.invoke.CAPTURE_CLIP)
    expect(inboxRpc.methods.capturePdf.channel).toBe(InboxChannels.invoke.CAPTURE_PDF)
  })

  it('wires filing + bulk methods', () => {
    expect(inboxRpc.methods.file.channel).toBe(InboxChannels.invoke.FILE)
    expect(inboxRpc.methods.bulkFile.channel).toBe(InboxChannels.invoke.BULK_FILE)
    expect(inboxRpc.methods.bulkArchive.channel).toBe(InboxChannels.invoke.BULK_ARCHIVE)
    expect(inboxRpc.methods.bulkTag.channel).toBe(InboxChannels.invoke.BULK_TAG)
    expect(inboxRpc.methods.bulkSnooze.channel).toBe(InboxChannels.invoke.BULK_SNOOZE)
  })

  it('trackSuggestion uses a custom implementation that passes through positional args', () => {
    const impl = inboxRpc.methods.trackSuggestion.implementation
    expect(impl).toBeTypeOf('string')
    expect(impl).toContain('input.itemId')
    expect(impl).toContain('input.suggestedTags ?? []')
  })

  it('linkToNote supplies a tags default in invokeArgs', () => {
    expect(inboxRpc.methods.linkToNote.invokeArgs).toEqual(['itemId', 'noteId', 'tags ?? []'])
  })

  it('wires core events to InboxChannels.events', () => {
    expect(inboxRpc.events.onInboxCaptured.channel).toBe(InboxChannels.events.CAPTURED)
    expect(inboxRpc.events.onInboxFiled.channel).toBe(InboxChannels.events.FILED)
    expect(inboxRpc.events.onInboxProcessingError.channel).toBe(
      InboxChannels.events.PROCESSING_ERROR
    )
  })

  it('list + listArchived + getFilingHistory default options to empty object', () => {
    expect(inboxRpc.methods.list.invokeArgs).toEqual(['options ?? {}'])
    expect(inboxRpc.methods.listArchived.invokeArgs).toEqual(['options ?? {}'])
    expect(inboxRpc.methods.getFilingHistory.invokeArgs).toEqual(['options ?? {}'])
  })
})
