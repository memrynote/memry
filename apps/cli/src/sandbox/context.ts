import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { createId } from '@memry/app-core/ids'

import type { MemryApp } from '../app-core/memry-app.ts'
import type { Clock } from './clock.ts'

export const ASSETS_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'assets')

export type AssetName =
  | 'audio-armstrong-small-step.ogg'
  | 'ocr-fannie-farmer-cookbook-p83.jpg'
  | 'ocr-fda-nutrition-facts.png'
  | 'ocr-strunk-elements-of-style-p24.jpg'
  | 'paper-note-taking-gestures.pdf'
  | 'photo-blue-marble.jpg'
  | 'photo-earthrise.jpg'
  | 'photo-grand-teton.jpg'
  | 'photo-loc-reading-room.jpg'
  | 'photo-mushroom-basket.jpg'
  | 'photo-pillars-of-creation.jpg'
  | 'photo-romanesco.jpg'
  | 'scan-apollo1-memo-1967.pdf'
  | 'scan-safire-moon-disaster-memo-1969.pdf'
  | 'video-apollo11-launch-commentary.webm'

export const assetPath = (name: AssetName): string => path.join(ASSETS_DIR, name)

export interface NoteRef {
  id: string
  path: string
  title: string
}

export interface TaskRef {
  id: string
  title: string
  done: boolean
}

export interface ProjectRef {
  id: string
  name: string
  /** Status id by status name. */
  statuses: Record<string, string>
  doneStatusId: string
}

/** A binary imported as its own file note. Its id is minted here; post/notes.ts registers it. */
export interface FileRef {
  id: string
  path: string
  asset: AssetName
}

export interface SandboxContext {
  app: MemryApp
  vaultPath: string
  clock: Clock
  notes: Map<string, NoteRef>
  /** Journal note id by `YYYY-MM-DD`. */
  journal: Map<string, string>
  projects: Map<string, ProjectRef>
  tasks: Map<string, TaskRef>
  events: Map<string, string>
  templates: Map<string, string>
  files: Map<string, FileRef>
  inbox: Map<string, string>
  canvasIds: Map<string, string>
}

export function createContext(app: MemryApp, vaultPath: string, clock: Clock): SandboxContext {
  return {
    app,
    vaultPath,
    clock,
    notes: new Map(),
    journal: new Map(),
    projects: new Map(),
    tasks: new Map(),
    events: new Map(),
    templates: new Map(),
    files: new Map(),
    inbox: new Map(),
    canvasIds: new Map()
  }
}

export function need<T>(map: Map<string, T>, key: string, kind: string): T {
  const value = map.get(key)
  if (value === undefined) throw new Error(`Sandbox content references unknown ${kind} "${key}"`)
  return value
}

/** Canvas ids are minted on first use, so tasks can link a canvas before its file exists. */
export function canvasId(ctx: SandboxContext, key: string): string {
  let id = ctx.canvasIds.get(key)
  if (!id) {
    id = createId('canvas')
    ctx.canvasIds.set(key, id)
  }
  return id
}

export type SandboxStep = (ctx: SandboxContext) => Promise<void>
