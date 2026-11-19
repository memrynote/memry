import {
  parseStickyKind,
  type StickyDraft,
  type StickyKind,
  type StickyWindowSession
} from '@memry/contracts/sticky-api'
import { getCurrentWebviewWindow } from '@tauri-apps/api/webviewWindow'
import { commands, events, type StickyDraftView } from '../../../generated/bindings'
import { subscribeToEvent } from './tauri-event'

function toDraft(view: StickyDraftView): StickyDraft {
  return { ...view, kind: parseStickyKind(view.kind) }
}

/**
 * The sticky window's drafts and window calls over their Rust commands. Send, undo and
 * open-target still go through `window.api.sticky` until they are ported (#3548 stage 31c).
 */
export const stickyService = {
  getSession: (): Promise<StickyWindowSession> => commands.stickyGetSession(),
  listDrafts: async (): Promise<StickyDraft[]> => (await commands.stickyListDrafts()).map(toDraft),
  saveDraft: async (input: { id?: string; content: string; kind: StickyKind }) =>
    toDraft(await commands.stickySaveDraft({ ...input, id: input.id ?? null })),
  deleteDraft: (id: string): Promise<boolean> => commands.stickyDeleteDraft(id),
  tuck: (): Promise<void> => commands.stickyTuck(),
  resize: (height: number): Promise<null> => commands.stickyResize(height),
  onDraftsChanged: (callback: () => void): (() => void) =>
    subscribeToEvent(events.stickyDraftsChangedEvent, callback),
  /**
   * Main asks this window, by its label, to write its draft before a quit. Listened on this
   * webview only, so the main window's requests never reach the sticky.
   */
  onFlushRequested: (callback: (requestId: string) => void, onListening: () => void) =>
    subscribeToEvent(
      events.flushRequestedEvent(getCurrentWebviewWindow()),
      ({ requestId }) => callback(requestId),
      onListening
    ),
  flushDone: (requestId: string): Promise<null> => commands.flushDone(requestId),
  flushReady: (): Promise<null> => commands.flushReady()
}
