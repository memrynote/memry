/**
 * Messages between main and the converter worker.
 *
 * Its own module so the bridge can type the wire without importing the worker
 * entry, which would pull the converter (BlockNote, jsdom) into the main bundle.
 */
import type { CalloutTypeDefinition } from '@memry/editor-schema/callout-types'
import type { WritingFrontmatter } from '@memry/shared/writing-tools/markdown'
import type { WritebackConversion } from './writeback-conversion'

/**
 * Built filename the bridge loads. Registered as a rollup input in
 * `electron.vite.config.ts` and listed in `scripts/check-worker-bundles.mjs`.
 */
export const CONVERTER_WORKER_FILE = 'converter-worker.js'

/** The work a job does; each answers with its own result. */
export type ConverterJob =
  /** A write-back pass: the doc's file body (`convertForWriteback`). */
  | { kind: 'writeback'; notePath: string }
  /** A seed: what `markdownToYFragment` adds to the doc, as an update. */
  | {
      kind: 'seed'
      markdown: string
      notePath: string | undefined
      writing: WritingFrontmatter | undefined
    }

export interface ConverterJobResults {
  writeback: WritebackConversion
  /** The update to apply to the doc, or null when the seed failed. */
  seed: Uint8Array | null
}

export type ToConverterWorker =
  | {
      type: 'job'
      jobId: number
      job: ConverterJob
      /** `Y.encodeStateAsUpdate` of the doc the job reads. */
      update: Uint8Array
      /** Main's custom callout types, which the parser reads from a process-wide registry. */
      calloutTypes: CalloutTypeDefinition[]
    }
  | { type: 'reply'; callId: number; ok: true; value: unknown }
  | { type: 'reply'; callId: number; ok: false; message: string }

/** What the worker asks main for: the work that needs the vault or its index. */
export type ConverterWorkerCall =
  | { op: 'readFileBody'; jobId: number }
  | { op: 'resolveEmbeds'; refs: string[]; notePath?: string }

export type FromConverterWorker =
  /** Sent once the converter has loaded, so a job can start without loading anything. */
  | { type: 'ready' }
  | { type: 'result'; jobId: number; result: ConverterJobResults[ConverterJob['kind']] }
  | { type: 'failed'; jobId: number; message: string }
  | ({ type: 'call'; callId: number } & ConverterWorkerCall)
