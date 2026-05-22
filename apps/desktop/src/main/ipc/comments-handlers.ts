import { BrowserWindow, ipcMain } from 'electron'
import { CommentsChannels } from '@memry/contracts/ipc-channels'
import {
  CreateCommentInputSchema,
  DeleteCommentInputSchema,
  LinkCommentAttachmentInputSchema,
  ListCommentsInputSchema,
  SetCommentStatusInputSchema,
  UpdateCommentInputSchema,
  type Comment,
  type CommentsChangedEvent
} from '@memry/contracts/comments-api'
import { createValidatedHandler } from './validate'
import {
  createComment,
  deleteComment,
  linkCommentAttachment,
  listComments,
  serializeComment,
  setCommentStatus,
  updateComment
} from '../comments/store'
import {
  syncCommentCreate,
  syncCommentDelete,
  syncCommentUpdate
} from '../comments/runtime-effects'

function emitCommentsChanged(event: CommentsChangedEvent): void {
  for (const win of BrowserWindow.getAllWindows()) {
    win.webContents.send(CommentsChannels.events.CHANGED, event)
  }
}

function emitChanged(comment: Comment, action: CommentsChangedEvent['action']): void {
  emitCommentsChanged({
    targetType: comment.targetType,
    targetId: comment.targetId,
    commentId: comment.id,
    action
  })
}

export function registerCommentsHandlers(): void {
  ipcMain.handle(
    CommentsChannels.invoke.LIST,
    createValidatedHandler(ListCommentsInputSchema, (input): Comment[] => listComments(input))
  )

  ipcMain.handle(
    CommentsChannels.invoke.CREATE,
    createValidatedHandler(CreateCommentInputSchema, (input): Comment => {
      const comment = createComment(input)
      syncCommentCreate(comment.id)
      emitChanged(comment, 'created')
      return comment
    })
  )

  ipcMain.handle(
    CommentsChannels.invoke.UPDATE,
    createValidatedHandler(UpdateCommentInputSchema, (input): Comment => {
      const comment = updateComment(input)
      syncCommentUpdate(comment.id)
      emitChanged(comment, 'updated')
      return comment
    })
  )

  ipcMain.handle(
    CommentsChannels.invoke.RESOLVE,
    createValidatedHandler(SetCommentStatusInputSchema, (input): Comment => {
      const comment = setCommentStatus(input.id, input.status)
      syncCommentUpdate(comment.id)
      emitChanged(comment, 'updated')
      return comment
    })
  )

  ipcMain.handle(
    CommentsChannels.invoke.ARCHIVE,
    createValidatedHandler(DeleteCommentInputSchema, (input): Comment => {
      const comment = setCommentStatus(input.id, 'archived')
      syncCommentUpdate(comment.id)
      emitChanged(comment, 'updated')
      return comment
    })
  )

  ipcMain.handle(
    CommentsChannels.invoke.DELETE,
    createValidatedHandler(DeleteCommentInputSchema, (input): { success: true } => {
      const comment = deleteComment(input.id)
      syncCommentDelete(comment.id, serializeComment(comment))
      emitChanged(comment, 'deleted')
      return { success: true }
    })
  )

  ipcMain.handle(
    CommentsChannels.invoke.LINK_ATTACHMENT,
    createValidatedHandler(LinkCommentAttachmentInputSchema, (input): Comment => {
      const comment = linkCommentAttachment(input.id, input.attachmentRef)
      syncCommentUpdate(comment.id)
      emitChanged(comment, 'updated')
      return comment
    })
  )
}

export function unregisterCommentsHandlers(): void {
  Object.values(CommentsChannels.invoke).forEach((channel) => {
    ipcMain.removeHandler(channel)
  })
}
