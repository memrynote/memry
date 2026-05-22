import type {
  Comment,
  CommentsChangedEvent,
  CreateCommentInput,
  LinkCommentAttachmentInput,
  ListCommentsInput,
  SetCommentStatusInput,
  UpdateCommentInput
} from '@memry/contracts/comments-api'

export type {
  Comment,
  CommentAnchorInput,
  CommentsChangedEvent,
  CommentTargetType,
  CreateCommentInput
} from '@memry/contracts/comments-api'

export const commentsService = {
  list: (input: ListCommentsInput): Promise<Comment[]> => window.api.comments.list(input),
  create: (input: CreateCommentInput): Promise<Comment> => window.api.comments.create(input),
  update: (input: UpdateCommentInput): Promise<Comment> => window.api.comments.update(input),
  resolve: (input: SetCommentStatusInput): Promise<Comment> => window.api.comments.resolve(input),
  archive: (id: string): Promise<Comment> => window.api.comments.archive(id),
  delete: (id: string): Promise<{ success: true }> => window.api.comments.delete(id),
  linkAttachment: (input: LinkCommentAttachmentInput): Promise<Comment> =>
    window.api.comments.linkAttachment(input)
}

export function onCommentsChanged(callback: (event: CommentsChangedEvent) => void): () => void {
  return window.api.onCommentsChanged(callback)
}
