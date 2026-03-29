import { z } from 'zod'
import { PropertyTypes } from '@memry/contracts/property-types'

const PROPERTY_TYPE_ENUM = z.enum([
  PropertyTypes.TEXT,
  PropertyTypes.NUMBER,
  PropertyTypes.CHECKBOX,
  PropertyTypes.DATE,
  PropertyTypes.URL,
  PropertyTypes.STATUS,
  PropertyTypes.SELECT,
  PropertyTypes.MULTISELECT
])

const PROPERTY_OPTION = z.object({
  value: z.string(),
  color: z.string(),
  default: z.boolean().optional()
})

export const CreatePropertyDefinitionSchema = z.object({
  name: z.string().min(1),
  type: PROPERTY_TYPE_ENUM,
  options: z.array(PROPERTY_OPTION).optional(),
  defaultValue: z.unknown().optional(),
  color: z.string().optional()
})

export const UpdatePropertyDefinitionSchema = z.object({
  name: z.string().min(1),
  type: PROPERTY_TYPE_ENUM.optional(),
  options: z.array(PROPERTY_OPTION).optional(),
  defaultValue: z.unknown().optional(),
  color: z.string().optional()
})

export const UploadAttachmentSchema = z.object({
  noteId: z.string().min(1),
  filename: z.string().min(1),
  data: z.instanceof(ArrayBuffer).or(z.array(z.number()))
})

export const DeleteAttachmentSchema = z.object({
  noteId: z.string().min(1),
  filename: z.string().min(1)
})

export const ExportNoteSchema = z.object({
  noteId: z.string().min(1),
  includeMetadata: z.boolean().default(true),
  pageSize: z.enum(['A4', 'Letter', 'Legal']).default('A4')
})

export const ImportFilesSchema = z.object({
  sourcePaths: z.array(z.string()),
  targetFolder: z.string().optional()
})
