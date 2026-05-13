import { z } from 'zod'

const captureTagsSchema = z.array(z.string().max(50)).max(20).optional()

const sourceFieldsSchema = {
  sourceUrl: z.string().max(2000).optional(),
  sourceTitle: z.string().max(200).optional()
}

export const ExtensionCaptureLinkSchema = z.object({
  kind: z.literal('link'),
  url: z.string().min(1).max(2000),
  tags: captureTagsSchema,
  ...sourceFieldsSchema
})

export const ExtensionCaptureClipSchema = z.object({
  kind: z.literal('clip'),
  html: z.string().max(100000).optional(),
  text: z.string().min(1).max(50000),
  tags: captureTagsSchema,
  sourceUrl: z.string().max(2000),
  sourceTitle: z.string().max(200)
})

export const ExtensionCapturePageSchema = z.object({
  kind: z.literal('page'),
  html: z.string().max(100000).optional(),
  text: z.string().min(1).max(50000),
  tags: captureTagsSchema,
  sourceUrl: z.string().max(2000),
  sourceTitle: z.string().max(200)
})

export const ExtensionCaptureFileSchema = z.object({
  kind: z.literal('file'),
  dataBase64: z.string().min(1),
  filename: z.string().min(1).max(255),
  mimeType: z.enum([
    'image/png',
    'image/jpeg',
    'image/gif',
    'image/webp',
    'image/svg+xml',
    'audio/mpeg',
    'audio/mp3',
    'audio/wav',
    'audio/ogg',
    'audio/mp4',
    'audio/x-m4a',
    'audio/flac',
    'audio/aac',
    'audio/webm',
    'video/mp4',
    'video/webm',
    'video/quicktime',
    'video/x-msvideo',
    'video/x-matroska',
    'application/pdf'
  ]),
  tags: captureTagsSchema,
  ...sourceFieldsSchema
})

export const ExtensionCapturePayloadSchema = z.discriminatedUnion('kind', [
  ExtensionCaptureLinkSchema,
  ExtensionCaptureClipSchema,
  ExtensionCapturePageSchema,
  ExtensionCaptureFileSchema
])

export const ExtensionCaptureEnvelopeSchema = z.object({
  schemaVersion: z.literal(1),
  capturedAt: z.string().datetime(),
  source: z.literal('chrome-extension'),
  capture: ExtensionCapturePayloadSchema
})

export type ExtensionCaptureEnvelope = z.infer<typeof ExtensionCaptureEnvelopeSchema>
export type ExtensionCapturePayload = z.infer<typeof ExtensionCapturePayloadSchema>
