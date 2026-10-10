// Helpers that turn content specs into the on-disk note-body format
// (docs/protocol/12-note-body-format.md). Each form here is the one desktop's
// serializer writes back unchanged, so opening a sandbox note never rewrites it.
import { serializeDateMentionToken, type RemindOffset } from '@memry/shared/date-mention'

import type { Clock } from './clock.ts'
import { canvasId, need, type AssetName, type SandboxContext } from './context.ts'

export interface Attached {
  ref: string
  name: string
  size: number
  mimeType: string
}

export interface DateOptions {
  time?: string
  remind?: RemindOffset
  format?: 'relative' | 'full'
}

export interface Body {
  clock: Clock
  day(offset: number): string
  /** `[[Title]]` for a note whose title is computed (dated meeting notes). */
  link(noteKey: string, alias?: string): string
  /** A task line bound to the task row (`{task:<id>}`), checked when the task is done. */
  task(taskKey: string): string
  date(offset: number, options?: DateOptions): string
  mention(url: string): string
  image(asset: AssetName, options?: { width?: number; caption?: string }): string
  file(
    name: string,
    options?: { width?: number; height?: number; align?: 'center' | 'right' }
  ): string
  video(asset: AssetName, caption: string): string
  audio(asset: AssetName): string
  /** Note-relative path of an attachment, for `cover` and table cells. */
  ref(name: string): string
  canvas(canvasKey: string): string
  uri: {
    note(noteKey: string): string
    task(taskKey: string): string
    event(eventKey: string): string
    canvas(canvasKey: string): string
    journal(offset: number): string
  }
}

// Mirror of desktop's encodeAttachmentUrl (apps/cli/src/app-core/note-files.ts).
const encodeUrl = (url: string): string =>
  url.replace(/ /g, '%20').replace(/\(/g, '%28').replace(/\)/g, '%29')

// Mirror of serializeLinkMentionToken (packages/editor-schema/src/inline/link-mention.ts).
// That module imports @blocknote/core, which this Node entry must not load.
const TOKEN_UNSAFE: Record<string, string> = {
  '!': '%21',
  "'": '%27',
  '(': '%28',
  ')': '%29',
  '*': '%2A',
  '~': '%7E',
  _: '%5F'
}

export function linkMention(url: string): string {
  const encoded = encodeURIComponent(url).replace(/[!'()*~_]/g, (char) => TOKEN_UNSAFE[char])
  return `((mention:${encoded}))`
}

/**
 * A GFM table padded the way desktop's house style re-saves it, so the first
 * edit near it does not reformat every row. The first row is the header.
 * Keep cells ASCII: padding counts UTF-16 units.
 */
export function table(rows: string[][]): string {
  const widths = rows[0].map((_, col) => Math.max(3, ...rows.map((row) => row[col].length)))
  const line = (cells: string[]): string =>
    `| ${cells.map((cell, col) => cell.padEnd(widths[col])).join(' | ')} |`
  return [line(rows[0]), line(widths.map((w) => '-'.repeat(w))), ...rows.slice(1).map(line)].join(
    '\n'
  )
}

export function createBody(
  ctx: SandboxContext,
  noteKey: string,
  attached: Map<string, Attached>
): Body {
  let mentions = 0
  const file = (name: string): Attached => need(attached, name, `attachment on ${noteKey}`)

  return {
    clock: ctx.clock,
    day: (offset) => ctx.clock.date(offset),
    link(key, alias) {
      const { title } = need(ctx.notes, key, 'note')
      return alias ? `[[${title}|${alias}]]` : `[[${title}]]`
    },
    task(key) {
      const task = need(ctx.tasks, key, 'task')
      return `- [${task.done ? 'x' : ' '}] ${task.title} {task:${task.id}}`
    },
    date(offset, options = {}) {
      mentions++
      const day = ctx.clock.date(offset)
      return serializeDateMentionToken({
        anchorId: `dm_${noteKey}_${mentions}`,
        dateISO: options.time ? ctx.clock.at(offset, options.time) : day,
        hasTime: Boolean(options.time),
        dateFormat: options.format ?? 'relative',
        remind: options.remind ?? 'none',
        timeFormat: 'system'
      })
    },
    mention: linkMention,
    image(asset, options = {}) {
      const { ref, name } = file(asset)
      const alt = options.width ? `${name}|${options.width}` : name
      if (!options.caption) return `![${alt}](${encodeUrl(ref)})`
      return `<figure><img alt="${alt}" src="${encodeUrl(ref)}"><figcaption>${options.caption}</figcaption></figure>`
    },
    file(name, options = {}) {
      const { ref, size, mimeType } = file(name)
      return `<!-- file:${JSON.stringify({
        url: ref,
        name,
        size,
        mimeType,
        ...(options.width ? { width: options.width, height: options.height } : {}),
        ...(options.align ? { align: options.align } : {})
      })} -->`
    },
    video(asset, caption) {
      return `<figure><video src="${encodeUrl(file(asset).ref)}" controls></video><figcaption>${caption}</figcaption></figure>`
    },
    audio(asset) {
      return `<audio src="${encodeUrl(file(asset).ref)}" controls></audio>`
    },
    ref: (name) => file(name).ref,
    canvas: (key) => `![whiteboard](memry://canvas/${canvasId(ctx, key)})`,
    uri: {
      note: (key) => `memry://note/${need(ctx.notes, key, 'note').id}`,
      task: (key) => `memry://task/${need(ctx.tasks, key, 'task').id}`,
      event: (key) => `memry://event/${need(ctx.events, key, 'event')}`,
      canvas: (key) => `memry://canvas/${canvasId(ctx, key)}`,
      journal: (offset) => `memry://journal/${ctx.clock.date(offset)}`
    }
  }
}
