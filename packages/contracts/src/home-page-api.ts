import { z } from 'zod'

import { HomePagesChannels } from './ipc-channels'
export { HomePagesChannels }

export const WidgetInstanceSchema = z.object({
  id: z.string().min(1),
  type: z.string().min(1),
  // Free-form grid placement (react-grid-layout units). x/y = top-left cell, w/h = span.
  x: z.number().int().min(0),
  y: z.number().int().min(0),
  w: z.number().int().min(1),
  h: z.number().int().min(1),
  config: z.record(z.string(), z.unknown()).default({})
})
export type WidgetInstance = z.infer<typeof WidgetInstanceSchema>

export const HomePageSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  icon: z.string().optional(),
  position: z.number().int().min(0),
  widgets: z.array(WidgetInstanceSchema)
})
export type HomePage = z.infer<typeof HomePageSchema>

export const HomePageCreateSchema = z.object({
  name: z.string().min(1),
  icon: z.string().optional(),
  position: z.number().int().min(0).default(0),
  widgets: z.array(WidgetInstanceSchema).default([])
})

export const HomePageUpdateSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1).optional(),
  icon: z.string().optional(),
  position: z.number().int().min(0).optional(),
  widgets: z.array(WidgetInstanceSchema).optional()
})

export const HomePageReorderSchema = z.object({
  ids: z.array(z.string().min(1))
})
