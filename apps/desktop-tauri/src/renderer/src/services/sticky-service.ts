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
import { getI18n } from 'react-i18next'
import { commands, events, type StickyDraftView } from '../../../generated/bindings'
import { commandErrorCode, extractErrorMessage } from '../lib/ipc-error'
import { subscribeToEvent } from './tauri-event'

function toDraft(view: StickyDraftView): StickyDraft {
  return { ...view, kind: parseStickyKind(view.kind) }
}

/** The text of each `sticky_*` refusal the send and the undo reject with. */
const REFUSAL_KEYS = new Map<string, string>([
  ['sticky_empty', 'inbox:sticky.errors.empty'],
  ['sticky_too_long', 'inbox:sticky.errors.sendFailed'],
  ['sticky_tasks_off', 'inbox:sticky.errors.tasksOff'],
  ['sticky_journal_off', 'inbox:sticky.errors.journalOff'],
  ['sticky_journal_busy', 'inbox:sticky.errors.journalBusy'],
  ['sticky_folder_excluded', 'inbox:sticky.errors.folderExcluded'],
  ['sticky_project_missing', 'inbox:sticky.errors.projectMissing'],
  ['sticky_undo_expired', 'inbox:sticky.errors.undoExpired']
])

/** A refusal in the user's language; any other failure reads as `extractErrorMessage` does. */
function refusal(error: unknown, fallbackKey: string): string {
  const key = REFUSAL_KEYS.get(commandErrorCode(error) ?? '')
  return key ? getI18n().t(key) : extractErrorMessage(error, getI18n().t(fallbackKey))
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
      return { success: false, error: refusal(error, 'inbox:sticky.errors.sendFailed') }
    }
  },
  undoSend: async (undoToken: string): Promise<StickyUndoResult> => {
    try {
      return { success: true, draft: toDraft(await commands.stickyUndoSend(undoToken)) }
    } catch (error) {
      return { success: false, error: refusal(error, 'inbox:sticky.errors.undoFailed') }
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
