import { CommentsChannels } from '@memry/contracts/ipc-channels'
import type {
  Comment,
  CommentsChangedEvent,
  CreateCommentInput,
  LinkCommentAttachmentInput,
  ListCommentsInput,
  SetCommentStatusInput,
  UpdateCommentInput
} from '@memry/contracts/comments-api'
import { invoke, subscribe } from '../lib/ipc'

export const commentsApi = {
  list: (input: ListCommentsInput) =>
    invoke(CommentsChannels.invoke.LIST, input) as Promise<Comment[]>,
  create: (input: CreateCommentInput) =>
    invoke(CommentsChannels.invoke.CREATE, input) as Promise<Comment>,
  update: (input: UpdateCommentInput) =>
    invoke(CommentsChannels.invoke.UPDATE, input) as Promise<Comment>,
  resolve: (input: SetCommentStatusInput) =>
    invoke(CommentsChannels.invoke.RESOLVE, input) as Promise<Comment>,
  archive: (id: string) => invoke(CommentsChannels.invoke.ARCHIVE, { id }) as Promise<Comment>,
  delete: (id: string) =>
    invoke(CommentsChannels.invoke.DELETE, { id }) as Promise<{ success: true }>,
  linkAttachment: (input: LinkCommentAttachmentInput) =>
    invoke(CommentsChannels.invoke.LINK_ATTACHMENT, input) as Promise<Comment>
}

export const commentsEvents = {
  onCommentsChanged: (callback: (event: CommentsChangedEvent) => void): (() => void) =>
    subscribe<CommentsChangedEvent>(CommentsChannels.events.CHANGED, callback)
}
