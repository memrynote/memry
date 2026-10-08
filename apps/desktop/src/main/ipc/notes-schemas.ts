import { z } from 'zod'

export const UploadAttachmentSchema = z.object({
  noteId: z.string().min(1),
  filename: z.string().min(1),
  data: z.instanceof(ArrayBuffer).or(z.array(z.number()))
})

export const DeleteAttachmentSchema = z.object({
  noteId: z.string().min(1),
  filename: z.string().min(1)
})
