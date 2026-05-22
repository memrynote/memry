import { z } from 'zod'
import { VectorClockSchema } from './sync-api'

export const CommentTargetTypeSchema = z.enum(['note', 'journal'])
export const CommentStatusSchema = z.enum(['open', 'resolved', 'archived'])

export const CommentAnchorInputSchema = z.object({
  selectedQuote: z.string().trim().min(1),
  blockId: z.string().nullable().optional(),
  rangeStart: z.number().int().nonnegative().nullable().optional(),
  rangeEnd: z.number().int().nonnegative().nullable().optional(),
  prefix: z.string().nullable().optional(),
  suffix: z.string().nullable().optional()
})

export const CommentSchema = z.object({
  id: z.string().min(1),
  targetType: CommentTargetTypeSchema,
  targetId: z.string().min(1),
  selectedQuote: z.string().min(1),
  blockId: z.string().nullable(),
  rangeStart: z.number().int().nonnegative().nullable(),
  rangeEnd: z.number().int().nonnegative().nullable(),
  prefix: z.string().nullable(),
  suffix: z.string().nullable(),
  body: z.string(),
  attachmentRefs: z.array(z.string()),
  status: CommentStatusSchema,
  clock: VectorClockSchema.nullable().optional(),
  syncedAt: z.string().nullable(),
  createdAt: z.string(),
  modifiedAt: z.string()
})

export const ListCommentsInputSchema = z.object({
  targetType: CommentTargetTypeSchema,
  targetId: z.string().min(1),
  status: z.union([CommentStatusSchema, z.array(CommentStatusSchema)]).optional()
})

export const CreateCommentInputSchema = CommentAnchorInputSchema.extend({
  targetType: CommentTargetTypeSchema,
  targetId: z.string().min(1),
  body: z.string().default(''),
  attachmentRefs: z.array(z.string()).default([])
})

export const UpdateCommentInputSchema = z.object({
  id: z.string().min(1),
  body: z.string().optional(),
  attachmentRefs: z.array(z.string()).optional()
})

export const SetCommentStatusInputSchema = z.object({
  id: z.string().min(1),
  status: CommentStatusSchema
})

export const DeleteCommentInputSchema = z.object({
  id: z.string().min(1)
})

export const LinkCommentAttachmentInputSchema = z.object({
  id: z.string().min(1),
  attachmentRef: z.string().min(1)
})

export const CommentsChangedEventSchema = z.object({
  targetType: CommentTargetTypeSchema,
  targetId: z.string().min(1),
  commentId: z.string().min(1),
  action: z.enum(['created', 'updated', 'deleted'])
})

export type CommentTargetType = z.infer<typeof CommentTargetTypeSchema>
export type CommentStatus = z.infer<typeof CommentStatusSchema>
export type CommentAnchorInput = z.infer<typeof CommentAnchorInputSchema>
export type Comment = z.infer<typeof CommentSchema>
export type ListCommentsInput = z.infer<typeof ListCommentsInputSchema>
export type CreateCommentInput = z.infer<typeof CreateCommentInputSchema>
export type UpdateCommentInput = z.infer<typeof UpdateCommentInputSchema>
export type SetCommentStatusInput = z.infer<typeof SetCommentStatusInputSchema>
export type DeleteCommentInput = z.infer<typeof DeleteCommentInputSchema>
export type LinkCommentAttachmentInput = z.infer<typeof LinkCommentAttachmentInputSchema>
export type CommentsChangedEvent = z.infer<typeof CommentsChangedEventSchema>
