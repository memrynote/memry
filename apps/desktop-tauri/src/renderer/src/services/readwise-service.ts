import type { ReadwiseSetOptionsInput } from '@memry/contracts/import-channels'
import { commands, events } from '../../../generated/bindings'
import { extractErrorMessage } from '../lib/ipc-error'
import { subscribeToEvent } from './tauri-event'

/**
 * The Readwise page over its Rust commands (`ipc/readwise-import-handlers.ts`), in Electron's
 * shapes: a value on success, `{ success: false, error }` with the command's sentence on
 * failure. Takeover, the first-import preview and the book commands are not ported yet: the
 * layer below answers them (`ported-api.ts`).
 */
type Failure = { success: false; error: string }

async function settle<T>(run: () => Promise<T>): Promise<T | Failure> {
  try {
    return await run()
  } catch (error) {
    return { success: false, error: extractErrorMessage(error, '') }
  }
}

const done = { success: true as const }

export const readwiseService = {
  status: () => settle(() => commands.importReadwiseStatus()),

  connect: (input: { token: string }) => settle(() => commands.importReadwiseConnect(input.token)),

  disconnect: () =>
    settle(async () => {
      await commands.importReadwiseDisconnect()
      return done
    }),

  syncNow: () =>
    settle(async () => {
      await commands.importReadwiseSyncNow()
      return done
    }),

  setOptions: (input: ReadwiseSetOptionsInput) => {
    const categories = input.categories
    return settle(() =>
      commands.importReadwiseSetOptions({
        rootFolder: input.rootFolder ?? null,
        folderLayout: input.folderLayout ?? null,
        categories: categories
          ? {
              books: categories.books ?? null,
              articles: categories.articles ?? null,
              tweets: categories.tweets ?? null,
              podcasts: categories.podcasts ?? null,
              supplementals: categories.supplementals ?? null
            }
          : null,
        cadence: input.cadence ?? null,
        readerDocuments: input.readerDocuments ?? null,
        readerFullText: input.readerFullText ?? null,
        journalHighlights: input.journalHighlights ?? null
      })
    )
  },

  cancel: () =>
    settle(async () => {
      await commands.importReadwiseCancel()
      return done
    }),

  ackErrorToast: () => settle(async () => ({ first: await commands.importReadwiseAckErrorToast() }))
}

/** `import:readwise:status-changed`: the page reads the status again. */
export function onReadwiseStatusChanged(callback: () => void): () => void {
  return subscribeToEvent(events.importReadwiseStatusChangedEvent, () => callback())
}
