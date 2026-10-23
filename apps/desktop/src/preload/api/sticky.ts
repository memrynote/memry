import { StickyChannels } from '@memry/contracts/ipc-channels'
import { invoke, subscribe } from '../lib/ipc'
import type {
  StickyDraft,
  StickyOpenTargetInput,
  StickySaveDraftInput,
  StickySendInput,
  StickySendResult,
  StickyUndoResult,
  StickyWindowSession
} from '@memry/contracts/sticky-api'

export const stickyApi = {
  listDrafts: (): Promise<StickyDraft[]> => invoke(StickyChannels.invoke.LIST_DRAFTS),
  saveDraft: (input: StickySaveDraftInput): Promise<StickyDraft> =>
    invoke(StickyChannels.invoke.SAVE_DRAFT, input),
  deleteDraft: (id: string): Promise<{ success: boolean }> =>
    invoke(StickyChannels.invoke.DELETE_DRAFT, { id }),
  send: (input: StickySendInput): Promise<StickySendResult> =>
    invoke(StickyChannels.invoke.SEND, input),
  undoSend: (undoToken: string): Promise<StickyUndoResult> =>
    invoke(StickyChannels.invoke.UNDO_SEND, { undoToken }),
  openTarget: (input: StickyOpenTargetInput): Promise<void> =>
    invoke(StickyChannels.invoke.OPEN_TARGET, input),
  getSession: (): Promise<StickyWindowSession> => invoke(StickyChannels.invoke.GET_SESSION),
  tuck: (): Promise<void> => invoke(StickyChannels.invoke.TUCK),
  unfold: (draftId: string | null): Promise<void> =>
    invoke(StickyChannels.invoke.UNFOLD, { draftId }),
  peek: (open: boolean): Promise<void> => invoke(StickyChannels.invoke.PEEK, { open }),
  resize: (height: number): Promise<void> => invoke(StickyChannels.invoke.RESIZE, { height }),
  onDraftsChanged: (callback: () => void): (() => void) =>
    subscribe<unknown>(StickyChannels.events.DRAFTS_CHANGED, () => {
      callback()
    }),
  onOpenTargetRequested: (callback: (target: StickyOpenTargetInput) => void): (() => void) =>
    subscribe<StickyOpenTargetInput>(StickyChannels.events.OPEN_TARGET_REQUESTED, callback)
}
