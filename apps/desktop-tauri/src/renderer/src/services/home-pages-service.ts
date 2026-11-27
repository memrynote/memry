/**
 * Home Pages Service
 *
 * The home board commands of Step 30c (`commands/home_pages.rs`) in the shapes of Electron's
 * `homePages:*` channels (`apps/desktop/src/preload/api/home-pages.ts`).
 */

import type {
  HomePage,
  HomePageCoverSource,
  HomePageSetCoverResult,
  WidgetInstance
} from '@memry/contracts/home-page-api'
import type { CoverFraming } from '@memry/shared/cover-image'
import {
  commands,
  events,
  type HomePageView,
  type SetCoverOutcome,
  type WidgetInput
} from '../../../generated/bindings'
import { invokeBinary } from '../lib/ipc-binary'
import { subscribeToEvent } from './tauri-event'

interface HomePageCreateInput {
  name: string
  icon?: string
  position?: number
  widgets?: WidgetInstance[]
}

interface HomePageUpdateInput {
  id: string
  name?: string
  icon?: string
  position?: number
  widgets?: WidgetInstance[]
}

// oxlint-disable-next-line typescript/no-unsafe-type-assertion -- a widget's config is the JSON the command carries as is
const toWidgets = (widgets?: WidgetInstance[]) => widgets as WidgetInput[] | undefined

/**
 * specta types every Rust `f64` as `number | null`, for NaN. A board's numbers come from stored
 * JSON, which holds no NaN, and an absent optional field is left out rather than sent as null.
 */
// oxlint-disable-next-line typescript/no-unsafe-type-assertion -- see above
const toPage = (view: HomePageView) => view as HomePage

function toResult(outcome: SetCoverOutcome): HomePageSetCoverResult {
  return outcome.status === 'saved'
    ? { ok: true, page: toPage(outcome.page) }
    : { ok: false, reason: outcome.reason }
}

async function setCover(id: string, source: HomePageCoverSource): Promise<HomePageSetCoverResult> {
  if (source.kind === 'upload') {
    const outcome = await invokeBinary<SetCoverOutcome>(
      'home_pages_set_cover_upload',
      new Uint8Array(source.data),
      { id, filename: source.filename }
    )
    return toResult(outcome)
  }
  return toResult(await commands.homePagesSetCover(id, source))
}

export const homePagesService = {
  list: async (): Promise<HomePage[]> => (await commands.homePagesList()).map(toPage),
  get: async (id: string): Promise<HomePage | null> => {
    const view = await commands.homePagesGet(id)
    return view ? toPage(view) : null
  },
  create: async (input: HomePageCreateInput): Promise<HomePage> =>
    toPage(await commands.homePagesCreate({ ...input, widgets: toWidgets(input.widgets) })),
  update: async (input: HomePageUpdateInput): Promise<HomePage> =>
    toPage(await commands.homePagesUpdate({ ...input, widgets: toWidgets(input.widgets) })),
  delete: async (id: string): Promise<{ success: boolean }> => ({
    success: await commands.homePagesDelete(id)
  }),
  reorder: async (ids: string[]): Promise<{ success: boolean }> => {
    await commands.homePagesReorder(ids)
    return { success: true }
  },
  setCover,
  setCoverFraming: async (id: string, changes: Partial<CoverFraming>): Promise<HomePage> =>
    toPage(await commands.homePagesSetCoverFraming(id, changes)),
  removeCover: async (id: string): Promise<HomePage> =>
    toPage(await commands.homePagesRemoveCover(id)),
  materializeCover: async (id: string): Promise<{ success: boolean }> => {
    await commands.homePagesMaterializeCover(id)
    return { success: true }
  }
}

// Event listeners: each carries the board's id; the board list refetches.
export function onHomePageCreated(callback: (event: { id: string }) => void): () => void {
  return subscribeToEvent(events.homePageCreatedEvent, callback)
}

export function onHomePageUpdated(callback: (event: { id: string }) => void): () => void {
  return subscribeToEvent(events.homePageUpdatedEvent, callback)
}

export function onHomePageDeleted(callback: (event: { id: string }) => void): () => void {
  return subscribeToEvent(events.homePageDeletedEvent, callback)
}
