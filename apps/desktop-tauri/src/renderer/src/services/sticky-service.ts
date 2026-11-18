import {
  parseStickyKind,
  type StickyDraft,
  type StickyKind,
  type StickyOpenTargetInput,
  type StickySendInput,
  type StickySendResult,
  type StickyUndoResult,
  type StickyWindowSession
} from '@memry/contracts/sticky-api'
import { getCurrentWebviewWindow } from '@tauri-apps/api/webviewWindow'
import { commands, events, type StickyDraftView } from '../../../generated/bindings'
import { subscribeToEvent } from './tauri-event'

function toDraft(view: StickyDraftView): StickyDraft {
  return { ...view, kind: parseStickyKind(view.kind) }
}

/** The rejected command's message, which main writes for the user (`sticky.errors.*`). */
function message(error: unknown): string {
  return typeof error === 'object' && error !== null && 'message' in error
    ? String(error.message)
    : String(error)
}

/** The sticky and edge tab windows' drafts, sends and window calls over their Rust commands. */
export const stickyService = {
  getSession: (): Promise<StickyWindowSession> => commands.stickyGetSession(),
  listDrafts: async (): Promise<StickyDraft[]> => (await commands.stickyListDrafts()).map(toDraft),
  saveDraft: async (input: { id?: string; content: string; kind: StickyKind }) =>
    toDraft(await commands.stickySaveDraft({ ...input, id: input.id ?? null })),
  deleteDraft: (id: string): Promise<boolean> => commands.stickyDeleteDraft(id),
  tuck: (): Promise<void> => commands.stickyTuck(),
  resize: (height: number): Promise<null> => commands.stickyResize(height),
  /** The edge tab: open the sticky on a draft, or blank for `null`. */
  unfold: (draftId: string | null): Promise<null> => commands.stickyUnfold(draftId),
  /** The edge tab: fan the draft list out, or fold it back. */
  peek: (open: boolean): Promise<null> => commands.stickyPeek(open),
  /** Sends the text where its kind says; a refusal resolves as `{ success: false }`, as in Electron. */
  send: async (input: StickySendInput): Promise<StickySendResult> => {
    try {
      const sent = await commands.stickySend(input)
      return { success: true, ...sent, kind: parseStickyKind(sent.kind) }
    } catch (error) {
      return { success: false, error: message(error) }
    }
  },
  undoSend: async (undoToken: string): Promise<StickyUndoResult> => {
    try {
      return { success: true, draft: toDraft(await commands.stickyUndoSend(undoToken)) }
    } catch (error) {
      return { success: false, error: message(error) }
    }
  },
  /** Main shows its window on what a send made and tucks the sticky. */
  openTarget: (target: StickyOpenTargetInput): Promise<null> =>
    commands.stickyOpenTarget(target.kind, target.targetId),
  /** The main window: the sticky asked it to open what a send made. Listened on this webview only. */
  onOpenTargetRequested: (callback: (target: StickyOpenTargetInput) => void): (() => void) =>
    subscribeToEvent(
      events.stickyOpenTargetRequestedEvent(getCurrentWebviewWindow()),
      ({ kind, targetId }) => callback({ kind: parseStickyKind(kind), targetId })
    ),
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
