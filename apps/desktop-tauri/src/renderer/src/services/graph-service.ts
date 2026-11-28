import type {
  GraphDataResponse,
  GraphLayout,
  LocalGraphRequest,
  SaveGraphLayoutRequest
} from '@memry/contracts/graph-api'

import { commands } from '../../../generated/bindings'
import { readBinary } from '@/lib/ipc-binary'

/** The graph commands answer raw JSON bytes (`commands/graph.rs`): a large vault's graph is megabytes. */
async function readGraph(
  command: string,
  args?: Record<string, unknown>
): Promise<GraphDataResponse> {
  const bytes = await readBinary(command, args)
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- the bytes are `domain::graph::GraphData` serialised in the `GraphDataResponseSchema` shape
  return JSON.parse(new TextDecoder().decode(bytes)) as GraphDataResponse
}

/** The graph view's data and saved layouts (`commands/graph.rs`), under Electron's names. */
export const graphService = {
  getData: (): Promise<GraphDataResponse> => readGraph('graph_get_graph_data'),
  /** `depth` defaults to 2 in the command, as `LocalGraphRequestSchema` does. */
  getLocal: (request: { noteId: string; depth?: LocalGraphRequest['depth'] }) =>
    readGraph('graph_get_local_graph', { noteId: request.noteId, depth: request.depth ?? null }),
  getLayout: (viewKey: string): Promise<GraphLayout | null> =>
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- `GraphLayoutView` is `GraphLayoutSchema` with `pinned` optional; version is always 1 here
    commands.graphGetLayout(viewKey) as Promise<GraphLayout | null>,
  saveLayout: async ({ viewKey, layout }: SaveGraphLayoutRequest): Promise<void> => {
    await commands.graphSaveLayout(viewKey, layout)
  },
  clearLayout: async (viewKey: string): Promise<void> => {
    await commands.graphClearLayout(viewKey)
  }
}
